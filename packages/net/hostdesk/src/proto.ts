// the probe's line protocol: a request id\tcmd\tbase64(arg), a reply
// id\tok|err\tbase64(payload), the same on both OSes

export type Reply = { id: number; ok: boolean; body: string };

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

export const request = (id: number, cmd: string, arg = "") => `${id}\t${cmd}\t${b64(arg)}\n`;

// one reply line, undefined for noise the shell printed
export function reply(line: string): Reply | undefined {
  const m = /^(\d+)\t(ok|err)\t([A-Za-z0-9+/=]*)\r?$/.exec(line);
  if (!m) return;
  return { id: Number(m[1]), ok: m[2] === "ok", body: Buffer.from(m[3]!, "base64").toString("utf8") };
}

// Records a Linux payload's records: \x1ekind\targs... then a body up to the next
export type Rec = { kind: string; args: string[]; body: string };

export function records(text: string): Rec[] {
  const out: Rec[] = [];
  for (const part of text.split("\x1e")) {
    if (!part) continue;
    const nl = part.indexOf("\n");
    const head = nl < 0 ? part : part.slice(0, nl);
    const body = nl < 0 ? "" : part.slice(nl + 1).replace(/\n$/, "");
    const [kind = "", ...args] = head.split("\t");
    if (kind) out.push({ kind, args, body });
  }
  return out;
}

// Windows' -EncodedCommand: the script's text as UTF-16LE base64
export const encodedCommand = (ps: string) => Buffer.from(ps, "utf16le").toString("base64");

// the bootstrap Windows runs: one base64 line read off stdin, run as the probe
export const winBoot =
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
  "$s=[Console]::In.ReadLine();" +
  "iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)))";

// Linux's the same way: read stops at its newline, leaving the requests on stdin, where
// sh -s reads its script ahead in blocks and takes requests already waiting as script
export const shBootScript = 'IFS= read -r s; eval "$(printf %s "$s" | base64 -d)"';
export const shBoot = `sh -c '${shBootScript}'`;

// the probe as either bootstrap reads it: one base64 line
export const bootLine = (script: string) => `${Buffer.from(script, "utf8").toString("base64")}\n`;
