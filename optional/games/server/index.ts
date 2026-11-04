// the game servers' server half: the games every host runs, listed with whether
// each is up, play and stop run on the game's host as its login, the admins' form
// for what exists, and the MCP tools
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { AppContext, Reply, Who } from "@phosphorus/app-sdk";
import { env, envInt, errText, now, StateDir } from "@phosphorus/util";
import { check, drop, gameOf, games, loginOf, loginRe, nameRe, save, setLogin } from "./config.ts";
import { authorize, type Key, keyIn, lookupUser, unauthorize } from "./keys.ts";
import { checkLogin, runAs } from "./run.ts";
import { tools } from "./tools.ts";

// starting/stopping shown this long after a press, or until the port flips
const actionMS: Record<string, number> = { start: 180_000, stop: 60_000 };
const probeMS = 10_000;
const pressMS = 75_000;
const logMax = 64 * 1024;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// one game as a page or an agent sees it
export type Row = {
  host: string;
  name: string;
  port: number;
  // online, offline, starting, stopping; down while its host is, unknown when it didn't say
  status: string;
  controllable: boolean;
  // the join address, on the tailnet
  address: string;
  start?: string;
  stop?: string;
};

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ host, port });
    s.setTimeout(1000);
    const end = (ok: boolean) => (s.destroy(), res(ok));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
    s.once("timeout", () => end(false));
  });
}

export function register(ctx: AppContext) {
  const self = ctx.host.toLowerCase();
  const key = (): Key => keyIn(ctx.dataDir);
  const pending = new Map<string, { action: string; until: number }>();
  const probes = new Map<number, { at: number; up: Promise<boolean> }>();

  // whether port answers here, on loopback or the tailnet address; asked at most every few seconds
  const up = (port: number) => {
    const p = probes.get(port);
    if (p && now() - p.at < probeMS) return p.up;
    const q = (async () =>
      (await connects("127.0.0.1", port)) || (await ctx.address(ctx.host).then((ip) => !!ip && connects(ip, port))))();
    probes.set(port, { at: now(), up: q });
    return q;
  };

  async function statusHere(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    await Promise.all(
      games(ctx.store)
        .filter((g) => g.host === self)
        .map(async (g) => {
          const p = pending.get(g.name);
          const pr = p && p.until > now() ? p.action : "";
          const on = await up(g.port);
          out[g.name] = on && pr === "stop" ? "stopping" : on ? "online" : pr === "start" ? "starting" : "offline";
        }),
    );
    return out;
  }

  // another host's app, its JSON as a reply
  async function ask(host: string, path: string, body: unknown, timeoutMs = 15_000): Promise<Reply> {
    const to = ctx.hosts().find((h) => h.toLowerCase() === host);
    if (!to) return [502, { error: `${host} isn't up` }];
    try {
      const res = await ctx.peerFetch(to, path, { method: "POST", body: JSON.stringify(body), timeoutMs });
      return [res.status, await res.json().catch(() => ({ error: `${host} answered ${res.status}` }))];
    } catch (e) {
      return [502, { error: `${host}: ${errText(e)}` }];
    }
  }

  async function list(admin: boolean): Promise<Row[]> {
    const all = games(ctx.store);
    const live = new Set(ctx.hosts().map((h) => h.toLowerCase()));
    const st = new Map<string, Record<string, string>>();
    await Promise.all(
      [...new Set(all.map((g) => g.host))].map(async (h) => {
        if (h === self) return void st.set(h, await statusHere());
        if (!live.has(h)) return;
        const [code, b] = (await ask(h, "/status", {}, 5000)) as [number, any];
        if (code === 200 && b && typeof b.status === "object") st.set(h, b.status);
      }),
    );
    return all.map((g) => ({
      host: g.host,
      name: g.name,
      port: g.port,
      status: st.get(g.host)?.[g.name] ?? (live.has(g.host) ? "unknown" : "down"),
      controllable: !!g.start,
      address: `${g.host}:${g.port}`,
      ...(admin ? { start: g.start, stop: g.stop } : {}),
    }));
  }

  async function pressHere(name: string, action: string): Promise<Reply> {
    const g = gameOf(ctx.store, self, name);
    if (!g) return [404, { error: `${self} hosts no game called ${name}` }];
    if (!g.start) return [409, { error: `${name} has no start and stop lines` }];
    const login = loginOf(ctx.store, self);
    if (!login) return [503, { error: `play/stop isn't set up on ${self}: an admin allows it with a login there` }];
    pending.set(name, { action, until: now() + actionMS[action]! });
    probes.delete(g.port);
    try {
      await runAs(login, key(), name, action, action === "start" ? g.start : g.stop);
    } catch (e) {
      pending.delete(name);
      ctx.log("%s: %s failed: %s", name, action, errText(e));
      return [502, { error: errText(e) }];
    }
    ctx.log("%s: %s ran", name, action);
    return [200, { ok: true }];
  }

  async function press(host: string, name: string, action: string): Promise<Reply> {
    if (action !== "start" && action !== "stop") return [400, { error: "action is start or stop" }];
    if (!nameRe.test(host) || !nameRe.test(name)) return [400, { error: "bad host or name" }];
    return host === self ? pressHere(name, action) : ask(host, "/press", { name, action }, pressMS);
  }

  // a game's start/stop output here, its last lines, from the log its runs leave
  // in the login's own folder
  async function logHere(name: string, lines: number): Promise<Reply> {
    if (!nameRe.test(name)) return [400, { error: "bad name" }];
    const login = loginOf(ctx.store, self);
    const u = login ? await lookupUser(login) : undefined;
    if (!u) return [404, { error: `no output from ${name} yet` }];
    const file =
      process.platform === "win32"
        ? join(u.home, "AppData", "Local", "phosphorus-games", name + ".log")
        : join(u.home, ".local", "state", "phosphorus-games", name + ".log");
    let text: string;
    try {
      const size = statSync(file).size;
      const b = Buffer.alloc(Math.min(size, logMax));
      const fd = openSync(file, "r");
      try {
        readSync(fd, b, 0, b.length, size - b.length);
      } finally {
        closeSync(fd);
      }
      text = b.toString("utf8");
    } catch {
      return [404, { error: `no output from ${name} yet` }];
    }
    const all = text.replace(/\n+$/, "").split(/\r?\n/);
    return [200, { host: self, name, lines: all.slice(-Math.max(1, Math.min(lines, 500))) }];
  }

  // play/stop run as login here, its password checked by this host's own sshd
  async function allowHere(login: string, pass: string): Promise<Reply> {
    if (!loginRe.test(login)) return [400, { error: "bad login" }];
    try {
      await checkLogin(
        { host: env("HOST_SSH_HOST", "127.0.0.1"), port: envInt("HOST_SSH_PORT", 22) || 22 },
        login,
        pass,
      );
    } catch (e) {
      return [403, { error: errText(e) }];
    }
    const was = loginOf(ctx.store, self);
    try {
      await authorize(login, key());
      if (was && was !== login) await unauthorize(was).catch(() => {});
    } catch (e) {
      return [500, { error: `couldn't authorize the key for ${login}: ${errText(e)}` }];
    }
    setLogin(ctx.store, self, login);
    ctx.log("play/stop runs as %s", login);
    return [200, { login }];
  }

  ctx.route("GET", "/games", async (r) => {
    const who = r.who as Who;
    const logins: Record<string, string> = {};
    if (who.admin) for (const h of ctx.hosts()) logins[h.toLowerCase()] = loginOf(ctx.store, h.toLowerCase());
    return [
      200,
      {
        admin: who.admin,
        hosts: ctx.hosts().map((h) => h.toLowerCase()),
        logins,
        games: await list(who.admin),
      },
    ];
  });

  ctx.route("POST", "/press", async (r) => {
    const b = (await r.json()) ?? {};
    return press(str(b.host).toLowerCase(), str(b.name), str(b.action));
  });

  ctx.route(
    "POST",
    "/game",
    async (r) => {
      const b = (await r.json()) ?? {};
      const g = check(b);
      if (typeof g === "string") return [400, { error: g }];
      const was = b.was && typeof b.was === "object" ? { host: str(b.was.host), name: str(b.was.name) } : undefined;
      const moved = was && (was.host !== g.host || was.name !== g.name);
      if ((!was || moved) && gameOf(ctx.store, g.host, g.name))
        return [409, { error: `${g.host} has a game called ${g.name} already` }];
      save(ctx.store, g);
      if (moved && nameRe.test(was.host) && nameRe.test(was.name)) drop(ctx.store, was.host, was.name);
      return [200, { ok: true }];
    },
    { admin: true },
  );

  ctx.route(
    "POST",
    "/remove",
    async (r) => {
      const b = (await r.json()) ?? {};
      const host = str(b.host),
        name = str(b.name);
      if (!gameOf(ctx.store, host, name)) return [404, { error: `${host} has no game called ${name}` }];
      drop(ctx.store, host, name);
      return [200, { ok: true }];
    },
    { admin: true },
  );

  // play/stop on host run as the asking admin's own saved login there
  ctx.route(
    "POST",
    "/allow",
    async (r) => {
      const host = str(((await r.json()) ?? {}).host).toLowerCase();
      if (!nameRe.test(host)) return [400, { error: "bad host" }];
      const who = r.who as Who;
      if (!(await ctx.vault.ready(who)))
        return [503, { error: "this host hasn't your saved logins yet, try again shortly" }];
      const l = await ctx.vault.login(who, host);
      if (!l) return [403, { error: `no saved login for ${host}: open a terminal on it and save the login` }];
      return host === self ? allowHere(l.user, l.pass) : ask(host, "/allow", { login: l.user, pass: l.pass });
    },
    { admin: true },
  );

  // another host's asks, for the games here
  ctx.route("POST", "/status", async () => [200, { status: await statusHere() }], { internal: true });
  ctx.route(
    "POST",
    "/press",
    async (r) => {
      const b = (await r.json()) ?? {};
      return press(self, str(b.name), str(b.action));
    },
    { internal: true },
  );
  ctx.route(
    "POST",
    "/log",
    async (r) => {
      const b = (await r.json()) ?? {};
      return logHere(str(b.name), Number(b.lines) || 50);
    },
    { internal: true },
  );
  ctx.route(
    "POST",
    "/allow",
    async (r) => {
      const b = (await r.json()) ?? {};
      return allowHere(str(b.login), typeof b.pass === "string" ? b.pass : "");
    },
    { internal: true },
  );

  // another host's game's output, or this one's
  const log = (host: string, name: string, lines: number): Promise<Reply> =>
    host === self ? logHere(name, lines) : ask(host, "/log", { name, lines });

  ctx.tools(tools({ list, press, log }));
}
