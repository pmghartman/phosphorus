// the code app's server half: claude or opencode sessions on a mesh host, run
// from here over ssh as the person's own saved login there; its calls under
// /api/app/code/, a page's socket on a session at /api/app/code/ws/<id>
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AppContext, AppRequest, Reply, Who } from "@phosphorus/app-sdk";
import { markdown } from "@phosphorus/web-md";
import * as code from "./code.ts";

const sessRe = /^\/sessions\/([a-z0-9]{12})(?:\/(send|stop|model|perm|permission|rename))?$/;
const wsRe = /^\/ws\/([a-z0-9]{12})$/;
const bodyMax = 512 * 1024;

// blockedMsg a person with no host login of their own: Code has nowhere to run
export const blockedMsg = "no saved login on any computer";

const obj = (v: unknown): Record<string, any> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const noStore = (r: code.Res): Response =>
  Response.json(r[1], { status: r[0], headers: { "Cache-Control": "no-store" } });

// body the request's JSON object, {} when empty or not one; a prompt may run past
// what the host's own json() takes
async function body(r: AppRequest): Promise<Record<string, any>> {
  const b = r.req.body;
  if (!b) return {};
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of b as unknown as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > bodyMax) return {};
    chunks.push(c);
  }
  try {
    return obj(JSON.parse(Buffer.concat(chunks).toString("utf8"))) ?? {};
  } catch {
    return {};
  }
}

export function register(ctx: AppContext) {
  const vault = ctx.vault;
  const runs = join(ctx.dataDir, "runs");
  code.setRunDir(runs);
  code.setHosts(
    () => ctx.host,
    (h) => ctx.address(h),
  );

  // why the person can't start anything, "" when they can: every start runs as a
  // login from their own vault
  async function blocked(who: Who): Promise<string> {
    if (!(await vault.ready(who))) return "this host hasn't your saved logins yet, try again shortly";
    if (!(await vault.hosts(who)).length) return blockedMsg;
    return "";
  }

  async function login(who: Who, host: string): Promise<code.Creds> {
    const l = await vault.login(who, host);
    if (!l) throw new Error(`no saved login for ${host}: open a terminal on it and save the login`);
    return code.creds(l);
  }

  // what a start needs of the person, read from their vault at each call and
  // handed to that start only
  const credsOf =
    (who: Who): code.CredsFn =>
    async (host) => {
      const cr = await login(who, host);
      const a = await vault.agent(who);
      cr.key = a.key;
      cr.base = a.base;
      cr.skill = a.skill;
      cr.token = await vault.anthropic(who);
      return cr;
    };

  // an Anthropic model asked for with no token saved
  const anthropicOff = async (who: Who, m: string) => code.Anthropic.includes(m) && (await vault.anthropic(who)) === "";
  const noToken: code.Res = [400, { error: "save your Anthropic token first" }];

  // the new session form's choices: the hosts the person has a login on and that
  // are up, the rest of their logins as offline
  async function options(who: Who): Promise<Record<string, any>> {
    const up = new Set(ctx.hosts());
    const has = (await vault.anthropic(who)) !== "";
    const models: Record<string, any>[] = code.Mesh.map((id) => ({ id, label: "Mesh model", provider: "mesh" }));
    if (has)
      for (const m of code.Anthropic)
        models.push({ id: m, label: m[0]!.toUpperCase() + m.slice(1), provider: "anthropic" });
    const logins = await vault.hosts(who);
    const why = await blocked(who);
    const out: Record<string, any> = {
      hosts: why ? [] : logins.filter((h) => up.has(h)),
      offline: why ? [] : logins.filter((h) => !up.has(h)),
      models,
      anthropic: has,
      harnesses: code.Harnesses,
    };
    if (why) out.blocked = why;
    return out;
  }

  // a call that runs something on a host: refused while the person has nowhere to run it
  const onHost =
    (h: (r: AppRequest, who: Who) => Promise<code.Res>) =>
    async (r: AppRequest): Promise<Reply> => {
      const who = r.who!;
      const why = await blocked(who);
      if (why) return noStore([403, { error: why }]);
      try {
        return noStore(await h(r, who));
      } catch (e) {
        return noStore([400, { error: errText(e) }]);
      }
    };
  const q = (r: AppRequest, k: string) => r.query.get(k) ?? "";

  ctx.route("GET", "/options", async (r) => noStore([200, await options(r.who!)]));
  ctx.route("GET", "/sessions", (r) => noStore(code.list(r.who!.user)));
  ctx.route(
    "POST",
    "/sessions",
    onHost(async (r, who) => {
      const p = await body(r);
      if (await anthropicOff(who, str(p.model))) return noToken;
      return code.create(who.user, p, credsOf(who));
    }),
  );
  ctx.route(
    "GET",
    "/harnesses",
    onHost(async (r, who) => code.harnessesOn(q(r, "host"), await login(who, q(r, "host")), q(r, "fresh") !== "")),
  );
  ctx.route(
    "POST",
    "/install",
    onHost(async (r, who) => {
      const p = await body(r);
      return code.installOf(str(p.host), await login(who, str(p.host)), str(p.harness), p.update === true);
    }),
  );
  ctx.route(
    "GET",
    "/ls",
    onHost(async (r, who) => code.ls(q(r, "host"), q(r, "dir"), await login(who, q(r, "host")))),
  );
  ctx.route(
    "POST",
    "/upload",
    onHost(async (r, who) => {
      const cr = await login(who, q(r, "host"));
      const cl = r.req.headers.get("content-length");
      const size = cl !== null && /^\d+$/.test(cl) ? Number(cl) : -1;
      const stream = r.req.body as unknown as AsyncIterable<Uint8Array> | null;
      return code.upload(q(r, "host"), q(r, "dir"), q(r, "name"), size, stream, cr);
    }),
  );
  ctx.route("*", "/sessions/*", async (r) => {
    const m = sessRe.exec(r.path);
    if (!m) return noStore([404, { error: "not found" }]);
    const who = r.who!;
    const id = m[1]!;
    const sub = m[2] ?? "";
    const meth = r.req.method;
    if (sub === "" && meth === "GET") return noStore(code.get(who.user, id));
    if (sub === "" && meth === "DELETE") return noStore(code.remove(who.user, id));
    if (sub === "" || meth !== "POST") return noStore([405, { error: "method not allowed" }]);
    if (sub === "send") return onHost(async (r, who) => code.send(who.user, id, await body(r), credsOf(who)))(r);
    const p = await body(r);
    switch (sub) {
      case "stop":
        return noStore(code.stop(who.user, id));
      case "model":
        if (await anthropicOff(who, str(p.model))) return noStore(noToken);
        return noStore(code.setModel(who.user, id, p));
      case "perm":
        return noStore(code.setPerm(who.user, id, p));
      case "permission":
        return noStore(code.answer(who.user, id, p));
      default:
        return noStore(code.rename(who.user, id, p));
    }
  });
  // the person's Anthropic subscription token, kept in their vault; "" clears it
  ctx.route("POST", "/anthropic", async (r) => {
    try {
      await vault.setAnthropic(r.who!, str((await body(r)).token).trim());
    } catch (e) {
      return noStore([400, { error: errText(e) }]);
    }
    return noStore([200, { anthropic: (await vault.anthropic(r.who!)) !== "" }]);
  });

  // the transcript's markdown, rendered here: the page carries no parser
  ctx.route("POST", "/md", async (r) => {
    const texts = (await body(r)).texts;
    const list: unknown[] = Array.isArray(texts) ? texts.slice(0, 500) : [];
    return noStore([200, { html: list.map((t) => markdown(str(t), true)) }]);
  });

  // a page's socket on a session: its log replayed past since, then live
  ctx.socket("/ws/*", (ws, who, at) => {
    const m = wsRe.exec(at.path);
    if (!who || !m || !code.owns(who.user, m[1]!)) {
      ws.close(4000);
      return;
    }
    const since = /^[+-]?\d+$/.test(at.query.get("since") ?? "") ? Number(at.query.get("since")) : 0;
    const done = new Promise<void>((r) => ws.onClose(r));
    const conn: code.Conn = {
      text: (s) => (ws.send(s), true),
      open: () => ws.open,
      queued: () => ws.queued(),
      close: (c) => ws.close(c),
    };
    void code.attach(conn, done, who.user, m[1]!, Math.max(since, 0)).then((had) => {
      if (!had) ws.close(4000);
    });
  });

  ctx.onStop(() => code.stopAll());
}
