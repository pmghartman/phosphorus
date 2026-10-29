// phosphorus in one process, the ingress, the mesh loop, the page, this
// host's state for peers, chat and terminal websockets

import * as chatmedia from "@phosphorus/chatmedia";
import * as files from "@phosphorus/files";
import * as git from "@phosphorus/git";
import { type Caller, type Loc, init as mcpInit } from "@phosphorus/mcp";
import * as mirror from "@phosphorus/mirror";
import { Assign, Summary } from "@phosphorus/model";
import * as peers from "@phosphorus/peers";
import { listen as ingressListen, serve as proxyServe } from "@phosphorus/proxy";
import { start as reconfigStart } from "@phosphorus/reconfig";
import * as stats from "@phosphorus/stats";
import * as store from "@phosphorus/store";
import * as update from "@phosphorus/update";
import * as users from "@phosphorus/users";
import { env, errText, flushWrites, logf, markHot, tailnetIP } from "@phosphorus/util";
import * as webapps from "@phosphorus/webapps";
import type { WSData } from "@phosphorus/wsock";
import type { Server } from "bun";
import {
  allPresence,
  chatEditAs,
  initChat,
  knownPerson,
  mergedChat,
  mergeFromPeers,
  mergePeerPresence,
  ownChatSince,
  peerSeq,
  postAs,
  showAs,
} from "./chat.ts";
import {
  baseDomain,
  bootID,
  getPlatform,
  ingressPort,
  isUpdating,
  loadPlatform,
  modelColor,
  port,
  recordPlatform,
  selfHost,
  selfInfo,
  setUpdating,
  Version,
} from "./config.ts";
import { configOp, hostConfig, hostLogsOn, svcRequest, userUI, userUIAsync } from "./hostops.ts";
import { meshOnly } from "./http.ts";
import { num } from "./js.ts";
import { chainHistory, meshHealth, opOn, rememberChain } from "./mcpops.ts";
import { reapShells } from "./mcpshell.ts";
import { appHandler } from "./routes.ts";
import {
  buildState,
  chainAction,
  forwardGame,
  gitRowsAny,
  hostServices,
  hostsInfo,
  ownState,
  publishHost,
  runGameLocally,
} from "./server.ts";
import { filesCall } from "./shares.ts";
import { copyAcross } from "./transfer.ts";
import { startPushes } from "./ws.ts";

// for a test mesh's hosts
export { mergedChat, postOwn } from "./chat.ts";
export { codeBlocked, codeBlockedMsg, codeLogin, codeOptions } from "./code.ts";
export { lineTime, logTime } from "./hostops.ts";
export { pageUser } from "./http.ts";
export { driveShell, errShellTimeout, Lines, readLines } from "./mcpshell.ts";
export { appHandler, buildState, Version };

// start everything but the signal wait: the frontend server, once listening
export async function start(): Promise<Server<WSData>> {
  loadPlatform();
  files.init();
  files.setOnChange(mirror.Touched);
  users.Init();
  store.start();
  users.DropOldTokens();
  chatmedia.init();
  git.init(isUpdating, bootID);
  update.onFinish(rememberChain);
  update.onFailed(() => setUpdating(false));
  initChat();
  setInterval(reapShells, 60000);

  // FRONTEND_BIND: one address alone, for a test mesh of several hosts on loopback
  const srv = proxyServe(port, meshOnly(appHandler), false, env("FRONTEND_BIND") || undefined);
  logf("[frontend] listening on port %d as %s, version %s", srv.port, selfHost || "an unnamed host", Version());
  recordPlatform();
  update.restoreChain();
  mirror.Start(tailnetIP, port);
  peers.onLinkUp(mirror.peerUp);
  webapps.Start(tailnetIP, port);
  webapps.StartServices({
    routes: peers.routes,
    tailnet: peers.tailnet,
    ipOf: tailnetIP,
    hostInfo: (h) => hostsInfo()[h],
    publishLocal: (name, fields) =>
      configOp(fields ? { op: "service", name, fields } : { op: "service", name, remove: true }),
  });
  ingressListen(ingressPort, appHandler, { pass: users.Pass, issuers: users.Issuers });
  stats.hooks.self = () => ({ host: selfHost, platform: getPlatform(), version: Version() });
  stats.hooks.peers = peers.peerIPs;
  await stats.init();
  initMCP();
  peers.start({
    mergeChat: mergeFromPeers,
    mergePresence: mergePeerPresence,
    platform: getPlatform,
    ownLock: update.ownLock,
    hostServices,
    own: ownState,
    ownChat: ownChatSince,
    chatSince: peerSeq,
    self: () => ({ version: Version(), bootId: bootID }),
  });
  publishHost();
  setInterval(publishHost, 2000);
  reconfigStart(() => isUpdating() || update.busy());
  startPushes();
  return srv;
}

// serve the frontend until SIGTERM, its exit code
export async function serve(): Promise<number> {
  try {
    await start();
  } catch (e) {
    logf("[frontend] can't listen on %d: %s", port, errText(e));
    return 1;
  }
  await new Promise<void>((r) => {
    process.once("SIGTERM", () => r());
    process.once("SIGINT", () => r());
  });
  await flushWrites();
  return 0;
}

function initMCP() {
  mcpInit({
    self: selfInfo,
    domain: () => baseDomain,
    tailnet: peers.tailnet,
    routes: peers.routes,
    peerIPs: peers.peerIPs,
    gitHosts: () => gitRowsAny(),
    model: Summary,
    chat: () => [...mergedChat],
    people: allPresence,
    lock: update.meshLock,
    chain: () => update.chainStatus() ?? peers.chain(),
    actions: {
      game: (host, name, action) =>
        host === selfHost ? runGameLocally(name, action) : forwardGame(host, name, action),
      gitMaster: (host) => {
        markHot();
        return git.makeMaster(host);
      },
      agentModel: (agent, slot, m) => {
        const [st, out] = Assign({ agent, slot, model: m });
        if (st === 200) markHot();
        return [st, out];
      },
      update: (action, admin, only) => {
        markHot();
        const [st, body] = chainAction(action, "", admin, only);
        if (st === 409) return [409, { error: "no update started here to " + action }];
        return [st, body];
      },
      files: filesCall,
      copy: (c: Caller | undefined, from: Loc, to: Loc, move: boolean) =>
        copyAcross(
          c,
          { host: from[0], share: from[1], path: from[2] },
          { host: to[0], share: to[1], path: to[2] },
          move,
        ),
      logs: hostLogsOn,
      op: (host, op, p) => {
        if (op === "mesh_health") return meshHealth().then((h) => [200, h] as [number, any]);
        if (op === "update_history") return [200, chainHistory()];
        let wait = 100000;
        if (op === "exec" || op === "shell") wait = (num(p?.timeout) + 30) * 1000;
        return opOn(host, op, p, wait);
      },
      chatEdit: chatEditAs,
      config: hostConfig,
      userUI,
      userUIAsync,
      service: svcRequest,
      modelColor,
    },
    post: postAs,
    show: showAs,
    locate: files.locate,
    known: knownPerson,
  });
}
