// the harnesses a session may run, each an optional install on a host: found
// by its own command, installed by its own official installer as the login
import { errText } from "@phosphorus/util";
import { type Creds, ocPath, pathPrefix, quote } from "./script.ts";
import { dial, install, run } from "./ssh.ts";

// Claude and Opencode the harnesses a session runs
export const Claude = "claude";
export const Opencode = "opencode";

export const hostRe = /^[A-Za-z0-9-]{1,63}$/;

// [status, body]: what every call here answers
export type Res = [number, any];
export const errB = (msg: string): Record<string, any> => ({ error: msg });

// Harness one agent CLI a session runs, as the pages offer it
export type Harness = {
  id: string;
  label: string;
  about: string;
  icon: string;
  // meshOnly runs on the mesh's models alone, never an Anthropic one
  meshOnly: boolean;
  // site where its installer comes from, for the install prompt
  site: string;
};

// bin its command; path what a non-login PATH lacks of where it installs
type harnessDef = Harness & { bin: string; path: string; install: string };

const defs: harnessDef[] = [
  { id: Claude, label: "Claude Code", about: "an agent in the project: it reads, runs and edits", icon: "spark", meshOnly: false,
    site: "claude.ai", bin: "claude", path: pathPrefix, install: "curl -fsSL https://claude.ai/install.sh | bash 2>&1" },
  { id: Opencode, label: "opencode", about: "an open agent in the project, on the mesh's models", icon: "terminal", meshOnly: true,
    site: "opencode.ai", bin: "opencode", path: ocPath, install: "curl -fsSL https://opencode.ai/install | bash 2>&1" },
];

const pub = ({ id, label, about, icon, meshOnly, site }: harnessDef): Harness => ({ id, label, about, icon, meshOnly, site });

// Harnesses every harness a session may run, in the pages' order
export const Harnesses: Harness[] = defs.map(pub);

// harnessByID the harness named, undefined for none
export const harnessByID = (id: string) => defs.find((h) => h.id === id);

export const harnessIDs = () => defs.map((h) => h.id);

// harnessOf a record's harness, claude for the ones from before there was a choice
export const harnessOf = (r: { harness?: string }) => r.harness || Claude;

// missing a harness not found on host, as a session's error
export function missing(id: string, host: string): string {
  const label = harnessByID(id)?.label ?? id;
  return `${label} isn't installed on ${host}: install it there first`;
}

// probeCommand every harness on a line: id, 1 when found or 0, its version
export function probeCommand(): string {
  let s = "";
  for (const h of defs)
    s += `(${h.path}command -v ${h.bin} >/dev/null 2>&1 && printf '${h.id}\\t1\\t%s\\n' "$(${h.bin} --version 2>/dev/null | head -n 1)" || printf '${h.id}\\t0\\t\\n'); `;
  return "sh -c " + quote(s);
}

// HarnessState a harness as found on one host
export type HarnessState = Harness & { installed: boolean; version: string };

const probed = new Map<string, { at: number; out: HarnessState[] }>();

// probeTTL a host's harnesses taken as found for this long, an install clearing it
const probeTTL = 2 * 60_000;

// harnessesOn every harness and whether host has it, as the login finds it
export async function harnessesOn(host: string, c: Creds, fresh: boolean): Promise<Res> {
  if (!hostRe.test(host)) return [400, errB("pick a host")];
  const k = host + "|" + c.user;
  const hit = probed.get(k);
  if (hit && !fresh && Date.now() - hit.at < probeTTL) return [200, { host, harnesses: hit.out }];
  let cl;
  try {
    cl = await dial(host, c.user, c.pass);
  } catch (e) {
    return [502, errB(errText(e))];
  }
  try {
    const r = await run(cl, probeCommand(), "", 30_000);
    if (r.error) return [502, errB(r.error)];
    const low = r.out.toLowerCase();
    if (r.code !== 0 && (low.includes("not recognized") || low.includes("commandnotfound")))
      return [200, { host, harnesses: [], why: host + " runs Windows, where no harness runs yet" }];
    const res = parseProbe(r.out);
    probed.set(k, { at: Date.now(), out: res });
    return [200, { host, harnesses: res }];
  } finally {
    cl.end();
  }
}

// parseProbe the probe's lines as every harness's state, one it didn't name missing
export function parseProbe(out: string): HarnessState[] {
  const found = new Map<string, string[]>();
  for (const l of out.split("\n")) {
    const f = l.replace(/\r+$/, "").split("\t");
    if (f.length >= 3) found.set(f[0]!, [f[1]!, f.slice(2).join("\t")]);
  }
  return defs.map((h) => {
    const f = found.get(h.id);
    const on = !!f && f[0] === "1";
    return { ...pub(h), installed: on, version: on ? f![1]!.trim() : "" };
  });
}

const installs = new Set<string>();

// installOf a harness's official installer run on host as the login
export async function installOf(host: string, c: Creds, id: string): Promise<Res> {
  const h = harnessByID(id);
  if (!hostRe.test(host)) return [400, errB("pick a host")];
  if (!h) return [400, errB("harness is one of " + harnessIDs().join(", "))];
  const k = host + "|" + c.user + "|" + id;
  if (installs.has(k)) return [409, errB("already installing on " + host)];
  installs.add(k);
  try {
    let r: { ok: boolean; out: string; error?: string };
    try {
      r = await install(host, c, "sh -c " + quote(h.path + h.install));
    } catch (e) {
      r = { ok: false, out: "", error: errText(e) };
    }
    probed.delete(host + "|" + c.user);
    if (r.error && !r.out) return [502, errB(r.error)];
    return [200, { ok: r.ok && !r.error, out: r.out }];
  } finally {
    installs.delete(k);
  }
}
