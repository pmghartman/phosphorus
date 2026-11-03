// the games the mesh runs, in the app's store slice: game/<host>/<name> with its
// port and the lines that start and stop it, login/<host> naming the account a
// host runs them as once someone with its password allowed it
import type { AppStore } from "@phosphorus/app-sdk";

export type Game = { host: string; name: string; port: number; start: string; stop: string };

export const nameRe = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const loginRe = /^[A-Za-z0-9._\\][A-Za-z0-9._\\ -]{0,63}$/;
const lineMax = 1000;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// a game as given, or why it isn't one
export function check(v: Record<string, unknown>): Game | string {
  const host = str(v.host).toLowerCase(),
    name = str(v.name),
    start = str(v.start),
    stop = str(v.stop);
  const port = typeof v.port === "string" && /^\d+$/.test(v.port) ? Number(v.port) : v.port;
  if (!nameRe.test(host)) return "pick a host";
  if (!nameRe.test(name)) return "a name is lowercase letters, digits and -";
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return "port is 1-65535";
  if (!start !== !stop) return "start and stop go together";
  for (const l of [start, stop]) {
    if (l.length > lineMax) return `a line is ${lineMax} characters at most`;
    if (/[\r\n]/.test(l)) return "a line is one line";
  }
  return { host, name, port, start, stop };
}

const rel = (host: string, name: string) => `game/${host}/${name}`;

// every game, by host then name
export function games(s: AppStore): Game[] {
  const out: Game[] = [];
  for (const r of s.list("game")) {
    const [host = "", name = ""] = r.split("/");
    const g = check({ ...(s.read(`game/${r}`) as Record<string, unknown>), host, name });
    if (typeof g !== "string") out.push(g);
  }
  return out;
}

export const gameOf = (s: AppStore, host: string, name: string) =>
  games(s).find((g) => g.host === host && g.name === name);

export function save(s: AppStore, g: Game) {
  s.write(rel(g.host, g.name), { port: g.port, start: g.start, stop: g.stop });
}

export const drop = (s: AppStore, host: string, name: string) => s.remove(rel(host, name));

// the account host runs its games as, "" before one's allowed
export function loginOf(s: AppStore, host: string): string {
  const l = str((s.read(`login/${host}`) as Record<string, unknown> | undefined)?.login);
  return loginRe.test(l) ? l : "";
}

export const setLogin = (s: AppStore, host: string, login: string) => s.write(`login/${host}`, { login });

// --- services.export -----------------------------------------------------------

const headRe = /^\[\s*(.*?)\s*\]$/;
const commentRe = /^[#;]/;

// the [sections] with type = game taken out of a host's services.export, as the
// core kept them before Games was an app: each game, and the text without them
export function takeGames(text: string): { found: Omit<Game, "host">[]; rest: string } {
  const lines = text.split("\n");
  const found: Omit<Game, "host">[] = [];
  const out: string[] = [];
  let sec: string[] = [];
  let name = "";
  const flush = () => {
    const f = new Map<string, string>();
    for (const l of sec.slice(1)) {
      const t = l.replace(/\r$/, "").trim();
      const eq = t.indexOf("=");
      if (!t || commentRe.test(t) || eq <= 0) continue;
      f.set(
        t.slice(0, eq).trim(),
        t
          .slice(eq + 1)
          .trim()
          .replace(/^"|"$/g, ""),
      );
    }
    const g = name && f.get("type") === "game" ? check({ ...Object.fromEntries(f), host: "x", name }) : "";
    if (typeof g === "string") out.push(...sec);
    else found.push({ name: g.name, port: g.port, start: g.start, stop: g.stop });
  };
  for (const l of lines) {
    const m = headRe.exec(l.replace(/\r$/, "").trim());
    if (m) {
      flush();
      sec = [];
      name = m[1]!;
    }
    sec.push(l);
  }
  flush();
  // the blank line a taken section left at the end
  return {
    found,
    rest: found.length
      ? out
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/^\n+/, "")
      : text,
  };
}
