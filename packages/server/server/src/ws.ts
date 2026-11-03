// the frontend's websockets: the state push, stats and terminals, here
// or spliced onto the owning peer's

import { Purge } from "@phosphorus/model";
import { acceptLink, HostHeader } from "@phosphorus/peers";
import { attach as statsAttach } from "@phosphorus/stats";
import * as term from "@phosphorus/term";
import { Of } from "@phosphorus/users";
import { errText, intervalMS, marshal, now, onHot, sleep, tailnetIP } from "@phosphorus/util";
import { type Conn, type Ctx, upgrade } from "@phosphorus/wsock";
import { appSocket } from "./apps.ts";
import { getPlatform, hostSSHHost, hostSSHPort, maxTerms, port, selfHost } from "./config.ts";
import { isLocalOrPeer, isLoopback, isTailnet, refuse, sameOrigin } from "./http.ts";
import { decode, obj, str } from "./js.ts";
import { mcpSocket } from "./mcpops.ts";
import { addPage, pageCount, toPages } from "./push.ts";
import { buildState, noteState } from "./server.ts";

const termPathRe = /^\/api\/term\/([a-z0-9][a-z0-9-]*)$/;
const sidRe = /^[0-9a-f]{32}$/;

let termConns = 0;

// accept the socket, ready run with it once open; a failed upgrade a 400
function accept(c: Ctx, ready: (ws: Conn) => void): Response | undefined {
  const ok = upgrade(c, (ws) => {
    ws.keepAlive();
    ready(ws);
  });
  return ok ? undefined : refuse(400);
}

const intOf = (v: string | null) => (v !== null && /^[+-]?\d+$/.test(v) ? Number(v) : 0);

export async function onUpgrade(c: Ctx, pathname: string, q: URLSearchParams): Promise<Response | undefined> {
  if (!(await isLocalOrPeer(c))) return refuse(403);
  switch (pathname) {
    case "/api/me/mcp": {
      const s = Of(c);
      if (!s || s.boot || !sameOrigin(c)) return refuse(403);
      return accept(c, (ws) => void mcpSocket(ws, s.user));
    }
    case "/api/state": {
      const s = Of(c);
      const user = s && !s.boot ? s.user : "";
      return accept(c, (ws) => {
        const st = buildState();
        noteState(st);
        ws.json(st);
        addPage(ws, user);
        ws.onMessage((raw) => void onPage(ws, user, raw));
      });
    }
    case "/api/peer": {
      // another host's link, the dialler named in its header: the tailnet, or this
      // machine, as the snapshot it replaces was
      const host = c.req.headers.get(HostHeader);
      const ip = c.ip;
      return accept(c, (ws) => void acceptLink(ws, host, ip));
    }
    case "/api/stats": {
      const own = q.has("own");
      if (own && !(await isTailnet(c)) && !isLoopback(c)) return refuse(403);
      return accept(c, (ws) => statsAttach(ws, own));
    }
  }
  const as = appSocket(c, pathname);
  if (as !== false) return as;
  const m = termPathRe.exec(pathname);
  if (!m) return refuse(404);
  const host = m[1]!;
  if (!sameOrigin(c)) return refuse(403);
  if (host !== selfHost && q.has("hop")) return refuse(421);
  if (!sidRe.test(q.get("sid") ?? "")) return refuse(400);
  const resume = q.has("resume");
  const n = Math.max(termConns, term.sessionCount());
  if (!resume && n >= maxTerms) return refuse(503);
  return accept(c, (ws) => {
    termConns++;
    ws.onClose(() => termConns--);
    if (host === selfHost) {
      const since = Math.max(intOf(q.get("since")), 0);
      let shell = "";
      switch (getPlatform()) {
        case "windows":
          shell = "powershell.exe -NoLogo";
          break;
        case "":
          break;
        default:
          shell = 'exec "$SHELL" -l';
      }
      term.attach(ws, {
        host,
        sid: q.get("sid")!,
        since,
        resume,
        sshHost: hostSSHHost,
        port: intOf(hostSSHPort),
        shell,
        auto: q.get("auto") === "1",
      });
      return;
    }
    q.set("hop", "1");
    term.forward(
      ws,
      host,
      async () => {
        const ip = await tailnetIP(host);
        return ip ? `ws://${ip}:${port}/api/term/${host}?${q}` : "";
      },
      resume,
    );
  });
}

// --- the state push ----------------------------------------------------------

const rttPush = 2000;

let pushedFp = "";
let pushedAt = 0;
let pushQueued = false;

function pushState() {
  if (!pageCount()) return;
  const s = buildState();
  const fp = noteState(s);
  if (fp === pushedFp && now() - pushedAt < rttPush) return;
  pushedFp = fp;
  pushedAt = now();
  toPages(marshal(s));
}

// a page's own ask: a logged in user's, the model host's idle slots erased
async function onPage(ws: Conn, user: string, raw: string | Uint8Array) {
  const msg = obj(decode(raw));
  if (!msg || user === "" || msg.type !== "model-purge") return;
  const host = str(msg.to);
  const body: Record<string, any> = { type: "model-purged", id: host };
  try {
    Object.assign(body, obj(JSON.parse(marshal(await Purge(host)))) ?? {});
  } catch (e) {
    body.error = errText(e);
  }
  if (ws.open()) ws.json(body);
}

export function startPushes() {
  onHot(() => {
    if (pushQueued) return;
    pushQueued = true;
    setTimeout(() => {
      pushQueued = false;
      pushState();
    }, 0);
  });
  void (async () => {
    for (;;) {
      pushState();
      await sleep(intervalMS());
    }
  })();
}
