// a persistent login shell per user per host, kept over the host's own sshd so
// a key's commands share one working directory, environment and background jobs
// across calls, the way a shell session does. each command ends with a marker
// line carrying its exit code, read back as that command's output.
import { randomBytes } from "node:crypto";
import { errText } from "@phosphorus/util";
import { Client, type ClientChannel } from "ssh2";
import { hostSSHHost, hostSSHPort, selfHost } from "./config.ts";
import type { Res } from "./http.ts";

const shellIdle = 30 * 60 * 1000;
const shellOutMax = 256 << 10;
export const execMax = 600;

// Coded an error with the status it answers
export class Coded extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

export const errShellTimeout = new Coded(504, "timeout");
export const errEOF = new Error("EOF");

export type ShellLine = { s: string; err?: Error };

// Lines a session's output as lines, each read on its own, a wait that times
// out leaving the line for the next
export class Lines {
  private q: ShellLine[] = [];
  private closed = false;
  private rest = "";
  private dec = new TextDecoder();
  private waiter?: () => void;

  push(b: Uint8Array) {
    this.rest += this.dec.decode(b, { stream: true });
    let i: number;
    while ((i = this.rest.indexOf("\n")) >= 0) {
      this.q.push({ s: this.rest.slice(0, i + 1) });
      this.rest = this.rest.slice(i + 1);
    }
    this.wake();
  }
  // the source gone: what's left, with the error, then nothing
  end(err: Error = errEOF) {
    if (this.closed) return;
    this.closed = true;
    this.rest += this.dec.decode();
    this.q.push({ s: this.rest, err });
    this.rest = "";
    this.wake();
  }
  private wake() {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }
  // the next line, null once closed and drained, undefined past timeoutMs
  async next(timeoutMs: number): Promise<ShellLine | null | undefined> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (this.q.length) return this.q.shift()!;
      if (this.closed) return null;
      const left = end - Date.now();
      if (left <= 0) return;
      const woke = await new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), left);
        this.waiter = () => {
          clearTimeout(t);
          r(true);
        };
      });
      if (!woke) return;
    }
  }
}

// readLines a byte stream's lines
export function readLines(src: AsyncIterable<Uint8Array>): Lines {
  const l = new Lines();
  void (async () => {
    try {
      for await (const b of src) l.push(b);
      l.end();
    } catch (e) {
      l.end(e instanceof Error ? e : new Error(String(e)));
    }
  })();
  return l;
}

export type Stdin = { write: (s: string) => Promise<void> | void };

type Shell = {
  client: Client;
  stream: ClientChannel;
  lines: Lines;
  marker: string;
  n: number;
  lastUse: number;
  dead: boolean;
  // one command at a time
  busy: Promise<unknown>;
};

const shells = new Map<string, Shell>();

// shellKey one session per user on this host
const shellKey = (user: string) => user;

// shellExec a command in the user's persistent shell here, the session opened
// on first use and reused after; reset drops any session first
export async function shellExec(
  user: string,
  pass: string,
  cmd: string,
  stdin: string,
  timeout: number,
  reset: boolean,
): Promise<Res> {
  if (user === "" || cmd.trim() === "") return [400, { error: "a login and a command" }];
  if (cmd.includes("\0")) return [400, { error: "the command holds a null byte" }];
  if (timeout < 1 || timeout > execMax) timeout = 60;
  const key = shellKey(user);
  if (reset) closeShell(key);
  let sh: Shell, fresh: boolean;
  try {
    [sh, fresh] = await getShell(key, user, pass);
  } catch (e) {
    return [e instanceof Coded ? e.status : 502, { error: errText(e) }];
  }
  let out: string, code: number, timedOut: boolean;
  try {
    [out, code, timedOut] = await runIn(sh, cmd, stdin, timeout * 1000);
  } catch (e) {
    closeShell(key);
    // a session that broke mid-reuse: reopen once and try again
    if (!fresh) return shellExec(user, pass, cmd, stdin, timeout, false);
    return [502, { error: `the shell on ${selfHost} stopped: ${errText(e)}` }];
  }
  const res: Record<string, any> = { host: selfHost, user, exit: code, output: out, session: true };
  if (timedOut) {
    closeShell(key);
    res.exit = null;
    res.timedOut = true;
    res.note = "the command ran past the timeout, so the session was closed; the next command opens a fresh one";
  }
  return [200, res];
}

async function getShell(key: string, user: string, pass: string): Promise<[Shell, boolean]> {
  const held = shells.get(key);
  if (held && !held.dead) return [held, false];
  const sh = await openShell(user, pass);
  shells.set(key, sh);
  return [sh, true];
}

function closeShell(key: string) {
  const sh = shells.get(key);
  shells.delete(key);
  if (sh) closeOne(sh);
}

function closeOne(s: Shell) {
  s.dead = true;
  try {
    s.stream.end();
  } catch {}
  try {
    s.client.end();
  } catch {}
}

async function openShell(user: string, pass: string): Promise<Shell> {
  const c = await sshDial(user, pass);
  let stream: ClientChannel;
  try {
    // a plain shell reading commands on stdin, errors folded into stdout
    stream = await new Promise<ClientChannel>((res, rej) => c.shell(false, (err, st) => (err ? rej(err) : res(st))));
  } catch (e) {
    c.end();
    throw new Coded(502, errText(e));
  }
  const m = randomBytes(8).toString("hex");
  const lines = new Lines();
  stream.on("data", (b: Uint8Array) => lines.push(b));
  stream.stderr.on("data", (b: Uint8Array) => lines.push(b));
  const sh: Shell = {
    client: c,
    stream,
    lines,
    marker: "__phos_" + m,
    n: 0,
    lastUse: Date.now(),
    dead: false,
    busy: Promise.resolve(),
  };
  stream.on("close", () => {
    lines.end();
    sh.dead = true;
  });
  c.on("close", () => {
    lines.end();
    sh.dead = true;
  });
  c.on("error", () => {});
  return sh;
}

// sshDial the host's own sshd as the saved login, password or keyboard-interactive
function sshDial(user: string, pass: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", (e) => {
      c.end();
      const msg = errText(e);
      reject(
        /authentication methods failed|unable to authenticate/i.test(msg)
          ? new Coded(403, `the saved login for ${selfHost} was refused`)
          : new Coded(502, `ssh to ${selfHost}: ${msg}`),
      );
    });
    c.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pass)));
    c.connect({
      host: hostSSHHost,
      port: Number(hostSSHPort) || 22,
      username: user,
      password: pass,
      tryKeyboard: true,
      readyTimeout: 10_000,
    });
  });
}

// runIn one command, its output up to the marker line, the marker's exit code,
// and whether the timeout cut it
function runIn(s: Shell, cmd: string, stdin: string, timeoutMs: number): Promise<[string, number, boolean]> {
  const turn = s.busy.then(async () => {
    s.lastUse = Date.now();
    s.n++;
    const tag = `${s.marker} ${s.n} `;
    const write = (text: string) =>
      new Promise<void>((res, rej) => {
        if (s.dead) return rej(new Error("the session is closed"));
        s.stream.write(text, (e?: Error | null) => (e ? rej(e) : res()));
      });
    const [out, code, err] = await driveShell({ write }, s.lines, cmd, stdin, tag, timeoutMs);
    if (err === errShellTimeout) return [out, code, true] as [string, number, boolean];
    if (err) throw err;
    return [out, code, false] as [string, number, boolean];
  });
  s.busy = turn.catch(() => {});
  return turn;
}

// driveShell feed one command, then a line printing the tag and $?, and read
// the combined output until that tag line; the core, ssh aside, so it is tested
// against a local shell
export async function driveShell(
  stdin: Stdin,
  lines: Lines,
  cmd: string,
  feed: string,
  tag: string,
  timeoutMs: number,
): Promise<[string, number, Error | undefined]> {
  // feed delivered by a heredoc so the command sees a bounded stdin that ends,
  // the shell's own stdin staying open for the marker and the next command
  let script = cmd + "\n";
  if (feed !== "") {
    const delim =
      "PHOS_IN_" +
      tag
        .trim()
        .split(/\s+/)[0]!
        .replace(/^__phos_/, "");
    script = cmd + " <<'" + delim + "'\n" + feed;
    if (!feed.endsWith("\n")) script += "\n";
    script += delim + "\n";
  }
  script += "printf '\\n%s%d\\n' '" + tag + '\' "$?"\n';
  try {
    await stdin.write(script);
  } catch (e) {
    return ["", -1, e instanceof Error ? e : new Error(String(e))];
  }
  let buf = "";
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ln = await lines.next(Math.max(0, end - Date.now()));
    if (ln === undefined) return [buf, -1, errShellTimeout];
    if (ln === null) return buf.length === 0 ? ["", -1, errEOF] : [trimOneNL(buf), -1, undefined];
    const t = ln.s.replace(/[\r\n]+$/, "");
    if (t.startsWith(tag)) {
      const code = Number.parseInt(t.slice(tag.length).trim(), 10);
      return [trimOneNL(buf), Number.isNaN(code) ? 0 : code, undefined];
    }
    if (ln.s !== "" && buf.length < shellOutMax) buf += ln.s;
    if (ln.err) return buf.length === 0 ? ["", -1, ln.err] : [trimOneNL(buf), -1, undefined];
  }
}

// trimOneNL trailing newlines dropped, the injected one and the command's own
const trimOneNL = (s: string) => s.replace(/\n+$/, "");

// reapShells idle sessions closed on a tick, called from the server's loop
export function reapShells() {
  for (const [k, sh] of [...shells]) {
    if (Date.now() - sh.lastUse > shellIdle || sh.dead) {
      shells.delete(k);
      closeOne(sh);
    }
  }
}
