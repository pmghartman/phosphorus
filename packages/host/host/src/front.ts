// phos alone: the front page, this host's state and the link to the desktop
// where every app is; the keys asked for line by line on a new host
import * as envfile from "@phosphorus/envfile";
import { FrontendPort } from "@phosphorus/util";
import { envPath, fail, keysMissing, println } from "./base.ts";
import { readPassword } from "./ctl.ts";
import { os } from "./os.ts";
import { tailscaleStatus } from "./tailnet.ts";

// the desktop's addresses: the mesh's domain first when there is one, then
// this host's name on the tailnet
export function desktopURLs(domain: string, host: string): string[] {
  const tail = `http://${host || "localhost"}/`;
  return domain ? [`https://${domain}/`, tail] : [tail];
}

// desktopLinks this host's desktop addresses as it knows them now
export async function desktopLinks(): Promise<string[]> {
  return desktopURLs(envfile.read(envPath()).BASE_DOMAIN ?? "", await tailnetHost());
}

export type Front = {
  version: string;
  running: boolean;
  host: string;
  domain: string;
  // phosphorus hosts answering and every one the tailnet has seen, while running
  up?: number;
  seen?: number;
};

// an OSC 8 hyperlink with the URL as its text, the URL alone off a terminal
const link = (url: string, tty: boolean) => (tty ? `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\` : url);

// the front page, coloured and linked on a terminal
export function frontPage(f: Front, tty: boolean): string {
  const sgr = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const mark = sgr("1;35"),
    dim = sgr("2"),
    ok = sgr("32"),
    warn = sgr("33"),
    off = sgr("31"),
    url = sgr("4;36");
  const on = f.host ? ` on ${f.host}` : "";
  let state: string;
  if (!f.running) state = `${off("●")} stopped${on}: phos start brings it up`;
  else {
    state = `${ok("●")} running${on}`;
    if (f.seen) state += `, ${(f.up! < f.seen ? warn : ok)(`${f.up} of ${f.seen}`)} hosts up`;
  }
  const [first, ...rest] = desktopURLs(f.domain, f.host);
  return [
    "",
    `  ${mark("phosphorus")} ${dim(f.version)}`,
    `  ${state}`,
    "",
    "  every app is on the desktop, open it in a browser:",
    `    ${url(link(first!, tty))}`,
    ...rest.map((u) => `    ${url(link(u, tty))}  ${dim("on the tailnet")}`),
    "",
    dim("  phos help lists the commands"),
    "",
  ].join("\n");
}

// this host's frontend asked for the mesh: its name and how many hosts answer
async function meshState(): Promise<{ host: string; up: number; seen: number } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${FrontendPort}/api/state`, {
      signal: AbortSignal.timeout(2000),
      proxy: false,
    } as RequestInit);
    if (!res.ok) return;
    const st: any = await res.json();
    let up = 0,
      seen = 0;
    for (const d of Array.isArray(st?.tailnet) ? st.tailnet : []) {
      if (d?.phosphorus) up++;
      if (d?.phosphorus || d?.phosphorusSeen) seen++;
    }
    return { host: String(st?.self?.host ?? ""), up, seen };
  } catch {
    return;
  }
}

// this host's name on the tailnet, as run names it
export async function tailnetHost(): Promise<string> {
  try {
    const dns = String(JSON.parse(await tailscaleStatus())?.Self?.DNSName ?? "");
    return (dns.split(".")[0] ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  } catch {
    return "";
  }
}

// front the page printed from what this host knows now
export async function front(version: string) {
  const running = await os.svcActive();
  const mesh = running ? await meshState() : undefined;
  const host = mesh?.host || (await tailnetHost());
  const domain = envfile.read(envPath()).BASE_DOMAIN ?? "";
  println(frontPage({ version, running, host, domain, up: mesh?.up, seen: mesh?.seen }, !!process.stdout.isTTY));
}

// askKeys .env's keys typed one per line with no echo, a blank one kept; false
// when nothing was saved
export async function askKeys(file: string): Promise<boolean> {
  if (!process.stdin.isTTY)
    throw fail("no terminal to type the keys in: use the Phosphorus app, or phos keys --stdin with KEY=value lines");
  const have = envfile.read(file);
  println("the keys for this host, typed without echo; a blank line keeps what's set");
  if (keysMissing()) println("joining a mesh: MESH_KEY alone, the rest copied from a peer");
  const vals: Record<string, string> = {};
  for (const k of envfile.Keys) {
    println(`\n${k.label} (${k.name}, ${have[k.name] ? "set" : "not set"}): ${k.hint}`);
    process.stdout.write("> ");
    const v = ((await readPassword()) ?? "").trim();
    println();
    if (v) vals[k.name] = v;
  }
  if (vals.MESH_KEY && !envfile.parseMeshKey(vals.MESH_KEY)) {
    println("that MESH_KEY isn't a mesh join key, nothing saved");
    return false;
  }
  if (!envfile.hasJoinKey({ ...have, ...vals })) {
    println("MESH_KEY is needed, nothing saved");
    return false;
  }
  if (Object.keys(vals).length === 0) {
    println("nothing typed, nothing changed");
    return false;
  }
  try {
    envfile.set(file, vals);
  } catch (e) {
    throw fail(`can't write ${file}: ${e instanceof Error ? e.message : e}`);
  }
  return true;
}
