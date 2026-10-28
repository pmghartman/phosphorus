// phosphorus in one process, the ingress, the mesh loop, the page, this
// host's state for peers, chat and terminal websockets
import type { Server } from "bun";
import * as chatmedia from "@phosphorus/chatmedia";
import { markHot } from "@phosphorus/clock";
import * as files from "@phosphorus/files";
import * as git from "@phosphorus/git";
import { type Caller, init as mcpInit, type Loc } from "@phosphorus/mcp";
import * as mesh from "@phosphorus/mesh";
import * as mirror from "@phosphorus/mirror";
import { Assign, Summary } from "@phosphorus/model";
import { listen as ingressListen, serve as proxyServe } from "@phosphorus/proxy";
import { start as reconfigStart } from "@phosphorus/reconfig";
import * as stats from "@phosphorus/stats";
import * as sysfs from "@phosphorus/sysfs";
import * as update from "@phosphorus/update";
import * as users from "@phosphorus/users";
import { errText, flushWrites, logf, tailnetIP } from "@phosphorus/util";
import * as webapps from "@phosphorus/webapps";
import type { WSData } from "@phosphorus/wsock";
import { allPresence, chatEditAs, initChat, knownPerson, mergedChat, mergeFromPeers, mergePeerPresence, postAs, showAs } from "./chat.ts";
import { baseDomain, bootID, getPlatform, ingressPort, isUpdating, loadPlatform, modelColor, port, recordPlatform, selfHost, selfInfo, setUpdating, Version } from "./config.ts";
import { hostConfig, hostLogsOn, svcRequest, userUI, userUIAsync } from "./hostops.ts";
import { meshOnly } from "./http.ts";
import { num } from "./js.ts";
import { chainHistory, meshHealth, opOn, rememberChain } from "./mcpops.ts";
import { reapShells } from "./mcpshell.ts";
import { appHandler } from "./routes.ts";
import { buildState, chainAction, forwardGame, gitRowsAny, hostServices, publishHost, runGameLocally, snapshot } from "./server.ts";
import { filesCall } from "./shares.ts";
import { copyAcross } from "./transfer.ts";
import { startPushes } from "./ws.ts";

export { appHandler, buildState, snapshot, Version };
export { codeBlocked, codeBlockedMsg, codeLogin, codeOptions } from "./code.ts";
export { pageUser } from "./http.ts";
export { lineTime, logTime } from "./hostops.ts";
export { driveShell, errShellTimeout, Lines, readLines } from "./mcpshell.ts";

// start everything but the signal wait: the frontend server, once listening
export async function start(): Promise<Server<WSData>> {
  loadPlatform();
  files.init();
  files.setOnChange(mirror.Touched);
  users.Init();
  sysfs.setPeerSources(mesh.peerIPs, mesh.peerSys);
  sysfs.start();
  users.DropOldTokens();
  chatmedia.init();
  git.init(isUpdating, bootID);
  update.onFinish(rememberChain);
  update.onFailed(() => setUpdating(false));
  initChat();
  setInterval(reapShells, 60000);

  const srv = proxyServe(port, meshOnly(appHandler), false);
  logf("[frontend] listening on port %d as %s, version %s", srv.port, selfHost || "an unnamed host", Version());
  recordPlatform();
  update.restoreChain();
  mirror.Start(tailnetIP, port);
  webapps.Start(tailnetIP, port);
  ingressListen(ingressPort, appHandler, { pass: users.Pass, issuers: users.Issuers });
  stats.hooks.self = () => ({ host: selfHost, platform: getPlatform(), version: Version() });
  stats.hooks.peers = mesh.peerIPs;
  await stats.init();
  initMCP();
  mesh.start({ mergeChat: mergeFromPeers, mergePresence: mergePeerPresence, platform: getPlatform, ownLock: update.ownLock, hostServices });
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
    tailnet: mesh.tailnet,
    routes: mesh.routes,
    peerIPs: mesh.peerIPs,
    gitHosts: () => gitRowsAny(),
    model: Summary,
    chat: () => [...mergedChat],
    people: allPresence,
    lock: update.meshLock,
    chain: () => update.chainStatus() ?? mesh.chain(),
    actions: {
      game: (host, name, action) => (host === selfHost ? runGameLocally(name, action) : forwardGame(host, name, action)),
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
        copyAcross(c, { host: from[0], share: from[1], path: from[2] }, { host: to[0], share: to[1], path: to[2] }, move),
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

