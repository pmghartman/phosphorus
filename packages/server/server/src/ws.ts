// the frontend's websockets: chat, the state push, stats, editors and
// terminals, here or spliced onto the owning peer's

import { Attach as collabAttach, Forward as collabForward } from "@phosphorus/collab";
import { acceptLink, HostHeader } from "@phosphorus/peers";
import { attach as statsAttach } from "@phosphorus/stats";
import * as term from "@phosphorus/term";
import { Of } from "@phosphorus/users";
import { intervalMS, marshal, now, onHot, sleep, tailnetIP } from "@phosphorus/util";
import { type Conn, type Ctx, upgrade } from "@phosphorus/wsock";
import { onChat } from "./chatws.ts";
import { codeSocket } from "./code.ts";
import { getPlatform, hostSSHHost, hostSSHPort, maxTerms, port, selfHost } from "./config.ts";
import { isLocalOrPeer, isLoopback, isTailnet, refuse, sameOrigin } from "./http.ts";
import { mcpSocket } from "./mcpops.ts";
import { buildState, noteState } from "./server.ts";
import { homeWho } from "./shares.ts";

const termPathRe = /^\/api\/term\/([a-z0-9][a-z0-9-]*)$/;
const codePathRe = /^\/api\/code\/([a-z0-9][a-z0-9-]*)$/;
const sidRe = /^[0-9a-f]{32}$/;

let termConns = 0;
const stateWS = new Set<Conn>();

// accept the socket, ready run with it once open; a failed upgrade a 400
function accept(c: Ctx, ready: (ws: Conn) => void): Response | undefined {
  const ok = upgrade(c, (ws) => {
    ws.keepAlive();
    ready(ws);
  });
  return ok ? undefined : refuse(400);
}

// nothing is read, as Go drained it
const drainWS = (ws: Conn) => ws.onMessage(() => {});

const intOf = (v: string | null) => (v !== null && /^[+-]?\d+$/.test(v) ? Number(v) : 0);

export async function onUpgrade(c: Ctx, pathname: string, q: URLSearchParams): Promise<Response | undefined> {
  if (!(await isLocalOrPeer(c))) return refuse(403);
  switch (pathname) {
    case "/api/chat": {
      const s = Of(c);
      return accept(c, (ws) => onChat(ws, s));
    }
    case "/api/me/mcp": {
      const s = Of(c);
      if (!s || s.boot || !sameOrigin(c)) return refuse(403);
      return accept(c, (ws) => void mcpSocket(ws, s.user));
    }
    case "/api/state":
      return accept(c, (ws) => {
        const s = buildState();
        noteState(s);
        ws.json(s);
        stateWS.add(ws);
        drainWS(ws);
        ws.onClose(() => stateWS.delete(ws));
      });
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
  const cs = codeSocket(c, pathname, q);
  if (cs !== false) return cs;
  let m = codePathRe.exec(pathname);
  if (m) {
    if (!sameOrigin(c)) return refuse(403);
    const host = m[1]!;
    if (host !== selfHost && q.has("hop")) return refuse(421);
    const who = await homeWho(c);
    return accept(c, (ws) => {
      if (host === selfHost) {
        void collabAttach(ws, q.get("share") ?? "", q.get("path") ?? "", who);
        return;
      }
      q.set("hop", "1");
      const cookie = c.req.headers.get("cookie") ?? "";
      collabForward(
        ws,
        async () => {
          const ip = await tailnetIP(host);
          return ip ? `ws://${ip}:${port}/api/code/${host}?${q}` : "";
        },
        cookie,
      );
    });
  }
  m = termPathRe.exec(pathname);
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
  if (!stateWS.size) return;
  const s = buildState();
  const fp = noteState(s);
  if (fp === pushedFp && now() - pushedAt < rttPush) return;
  pushedFp = fp;
  pushedAt = now();
  const text = marshal(s);
  for (const c of [...stateWS]) c.text(text);
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
