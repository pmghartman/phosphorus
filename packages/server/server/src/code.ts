// the code service's calls: harness sessions on a mesh host, run from here
import * as code from "@phosphorus/code";
import { skill } from "@phosphorus/mcp";
import { Summary } from "@phosphorus/model";
import {
  AnthropicToken,
  HostLogin,
  HostLogins,
  KeyOf,
  MCPBase,
  Of,
  type Session,
  Soon,
  VaultOK,
} from "@phosphorus/users";
import { errText, FrontendPort, tailnetIP } from "@phosphorus/util";
import { type Ctx, upgrade } from "@phosphorus/wsock";
import { selfHost } from "./config.ts";
import { forbidden, isLocalOrPeer, type Res, readRaw, refuse, sameOrigin, sendJSON } from "./http.ts";
import { decode, obj, str } from "./js.ts";

const codeSessRe = /^\/api\/code\/sessions\/([a-z0-9]{12})(?:\/(send|stop|model|perm|permission|rename))?$/;
const codeWSRe = /^\/api\/code\/ws\/([a-z0-9]{12})$/;

// meshBase this frontend as another host reaches it over the tailnet
async function meshBase(): Promise<string> {
  const ip = await tailnetIP(selfHost);
  if (!ip) throw new Error(`can't find ${selfHost}'s own tailnet address`);
  return `http://${ip}:${FrontendPort}`;
}

// codeBlockedMsg a user with no host login of their own: Code has nowhere to run
export const codeBlockedMsg = "no saved login on any computer";

// codeBlocked why the user can't start anything, "" when they can: every
// start runs as a login from their own vault, opened by their session
export async function codeBlocked(s: Session): Promise<string> {
  if (!(await VaultOK(s))) return "this host hasn't your saved logins yet, try again shortly";
  if (!(await HostLogins(s)).length) return codeBlockedMsg;
  return "";
}

// codeLogin the session's vault login for host, as creds
export async function codeLogin(s: Session, host: string): Promise<code.Creds> {
  const [user, pass, ok] = await HostLogin(s, host);
  if (!ok) throw new Error(`no saved login for ${host}: open a terminal on it and save the login`);
  return code.creds({ user, pass });
}

// codeCreds what a start needs of the logged in user, read from their vault
// at each call and handed to that start only
function codeCreds(s: Session, c: Ctx): code.CredsFn {
  return async (host) => {
    const cr = await codeLogin(s, host);
    const [key, ok] = await KeyOf(s, c);
    if (!ok) throw new Error("this host hasn't your mcp key yet, try again shortly");
    const base = await meshBase();
    // the skill names the address the user knows, the base domain's when there is one
    const sb = process.env.BASE_DOMAIN ? MCPBase(c) : base;
    cr.key = key;
    cr.token = await AnthropicToken(s);
    cr.base = base;
    cr.skill = await skill(sb);
    return cr;
  };
}

// codeOptions the new session form's choices
export async function codeOptions(s: Session): Promise<Record<string, any>> {
  let ro: Record<string, any> = {};
  for (const a of Summary().agents as any[]) if (obj(a)?.id === "code") ro = obj(obj(obj(a)?.slots)?.model) ?? {};
  const models: any[] = [];
  for (const m of code.Mesh)
    models.push({ id: m, label: "Mesh model", provider: "mesh", ready: ro.ready === true, why: str(ro.why) });
  const has = (await AnthropicToken(s)) !== "";
  if (has)
    for (const m of code.Anthropic)
      models.push({ id: m, label: m[0]!.toUpperCase() + m.slice(1), provider: "anthropic", ready: true, why: "" });
  const out: Record<string, any> = { hosts: await HostLogins(s), models, anthropic: has, harnesses: code.Harnesses };
  const why = await codeBlocked(s);
  if (why) {
    out.hosts = [];
    out.blocked = why;
  }
  return out;
}

// codeRoute the app's REST, undefined for a path that isn't one
export async function codeRoute(c: Ctx, pathname: string, q: URLSearchParams): Promise<Response | undefined> {
  const m = codeSessRe.exec(pathname);
  const known =
    !!m ||
    pathname === "/api/code/options" ||
    pathname === "/api/code/sessions" ||
    pathname === "/api/code/install" ||
    pathname === "/api/code/harnesses" ||
    pathname === "/api/code/ls" ||
    pathname === "/api/code/upload";
  if (!known) return;
  const meth = c.req.method;
  if (!(await isLocalOrPeer(c)) || (meth !== "GET" && !sameOrigin(c))) return forbidden();
  const reply = (r: Res) => sendJSON(r[0], r[1], { "Cache-Control": "no-store" });
  const s = await Soon(c);
  if (!s || s.boot) return reply([401, { error: "log in as a user" }]);
  const body = async (): Promise<Record<string, any>> => {
    const b = await readRaw(c, 512 * 1024);
    return (b && obj(decode(b))) || {};
  };
  const qs = (k: string) => q.get(k) ?? "";
  const sub = m?.[2] ?? "";
  // whatever runs on a host needs a login of the user's own there
  const starts =
    (pathname === "/api/code/sessions" && meth === "POST") ||
    pathname === "/api/code/install" ||
    pathname === "/api/code/harnesses" ||
    pathname === "/api/code/ls" ||
    pathname === "/api/code/upload" ||
    (!!m && sub === "send" && meth === "POST");
  if (starts) {
    const why = await codeBlocked(s);
    if (why) return reply([403, { error: why }]);
  }
  const login = async (host: string): Promise<code.Creds | Response> => {
    try {
      return await codeLogin(s, host);
    } catch (e) {
      return reply([400, { error: errText(e) }]);
    }
  };
  if (pathname === "/api/code/options" && meth === "GET") return reply([200, await codeOptions(s)]);
  if (pathname === "/api/code/sessions" && meth === "GET") return reply(code.list(s.user));
  if (pathname === "/api/code/sessions" && meth === "POST") {
    const p = await body();
    if (await anthropicOff(s, str(p.model)))
      return reply([400, { error: "save your Anthropic token in settings first" }]);
    return reply(await code.create(s.user, p, codeCreds(s, c)));
  }
  if (pathname === "/api/code/harnesses" && meth === "GET") {
    const cr = await login(qs("host"));
    if (cr instanceof Response) return cr;
    return reply(await code.harnessesOn(qs("host"), cr, qs("fresh") !== ""));
  }
  if (pathname === "/api/code/install" && meth === "POST") {
    const p = await body();
    const cr = await login(str(p.host));
    if (cr instanceof Response) return cr;
    return reply(await code.installOf(str(p.host), cr, str(p.harness)));
  }
  if (pathname === "/api/code/ls" && meth === "GET") {
    const cr = await login(qs("host"));
    if (cr instanceof Response) return cr;
    return reply(await code.ls(qs("host"), qs("dir"), cr));
  }
  if (pathname === "/api/code/upload" && meth === "POST") {
    const cr = await login(qs("host"));
    if (cr instanceof Response) return cr;
    const cl = c.req.headers.get("content-length");
    const size = cl !== null && /^\d+$/.test(cl) ? Number(cl) : -1;
    return reply(
      await code.upload(
        qs("host"),
        qs("dir"),
        qs("name"),
        size,
        c.req.body as unknown as AsyncIterable<Uint8Array> | null,
        cr,
      ),
    );
  }
  if (m && sub === "" && meth === "GET") return reply(code.get(s.user, m[1]!));
  if (m && sub === "" && meth === "DELETE") return reply(code.remove(s.user, m[1]!));
  if (m && sub !== "" && meth === "POST") {
    const id = m[1]!,
      p = await body();
    switch (sub) {
      case "send":
        return reply(await code.send(s.user, id, p, codeCreds(s, c)));
      case "stop":
        return reply(code.stop(s.user, id));
      case "model":
        if (await anthropicOff(s, str(p.model)))
          return reply([400, { error: "save your Anthropic token in settings first" }]);
        return reply(code.setModel(s.user, id, p));
      case "perm":
        return reply(code.setPerm(s.user, id, p));
      case "permission":
        return reply(code.answer(s.user, id, p));
      case "rename":
        return reply(code.rename(s.user, id, p));
    }
  }
  return reply([405, { error: "method not allowed" }]);
}

// anthropicOff an Anthropic model asked for with no token saved
async function anthropicOff(s: Session, m: string): Promise<boolean> {
  if (!code.Anthropic.includes(m)) return false;
  return (await AnthropicToken(s)) === "";
}

// codeSocket a page's socket on a session, undefined for a path that isn't one
export function codeSocket(c: Ctx, pathname: string, q: URLSearchParams): Response | undefined | false {
  const m = codeWSRe.exec(pathname);
  if (!m) return false;
  if (!sameOrigin(c)) return refuse(403);
  const s = Of(c);
  if (!s || s.boot) return refuse(401);
  if (!code.owns(s.user, m[1]!)) return refuse(404);
  const since = /^[+-]?\d+$/.test(q.get("since") ?? "") ? Number(q.get("since")) : 0;
  const ok = upgrade(c, (ws) => {
    ws.keepAlive();
    // nothing is read, as Go drained it
    ws.onMessage(() => {});
    void code.attach(ws, ws.done(), s.user, m[1]!, Math.max(since, 0)).then((had) => {
      if (!had) ws.close(4000);
    });
  });
  if (!ok) return refuse(400);
}
