// phosphorus in one process, the ingress, the mesh loop, the page, this
// host's state for peers, and the websockets

import { busy as appsBusy, reapApps } from "@phosphorus/appstream";
import { reap as reapWeb, busy as webBusy } from "@phosphorus/appweb";
import * as catalog from "@phosphorus/catalog";
import { migrate as migrateConfig } from "@phosphorus/config";
import * as files from "@phosphorus/files";
import { reap as reapDesks } from "@phosphorus/hostdesk";
import { type Caller, type Loc, init as mcpInit } from "@phosphorus/mcp";
import { Assign, Summary } from "@phosphorus/model";
import * as peers from "@phosphorus/peers";
import { listen as ingressListen, serve as proxyServe } from "@phosphorus/proxy";
import { start as reconfigStart } from "@phosphorus/reconfig";
import * as services from "@phosphorus/services";
import { setStackRows } from "@phosphorus/services";
import * as stacks from "@phosphorus/stacks";
import * as stats from "@phosphorus/stats";
import * as store from "@phosphorus/store";
import * as homesync from "@phosphorus/sync";
import * as update from "@phosphorus/update";
import * as users from "@phosphorus/users";
import { env, errText, flushWrites, logf, markHot, RestartExit, tailnetIP } from "@phosphorus/util";
import * as webapps from "@phosphorus/webapps";
import type { WSData } from "@phosphorus/wsock";
import type { Server } from "bun";
import { startApps, stopApps } from "./apps.ts";
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
import { startEdge, stopEdge } from "./edge.ts";
import { startHA, stopHA } from "./ha.ts";
import { hostConfig, hostLogsOn, svcRequest, userUI, userUIAsync } from "./hostops.ts";
import { meshOnly } from "./http.ts";
import { num } from "./js.ts";
import { chainHistory, meshHealth, opOn, rememberChain } from "./mcpops.ts";
import { reapShells } from "./mcpshell.ts";
import { appsOp, stacksOp } from "./mcpstacks.ts";
import { startMeshDNS, stopMeshDNS } from "./meshdns.ts";
import { appHandler } from "./routes.ts";
import { buildState, chainAction, hostServices, hostsInfo, ownState, publishHost, stackHosts } from "./server.ts";
import { filesCall } from "./shares.ts";
import { copyTree, homeRemote } from "./transfer.ts";
import { startPushes } from "./ws.ts";

// for a test mesh's hosts
export { runningApps } from "./apps.ts";
export { lineTime, logTime } from "./hostops.ts";
export { pageUser } from "./http.ts";
export { driveShell, errShellTimeout, Lines, readLines } from "./mcpshell.ts";
export { appHandler, buildState, Version };

// start everything but the signal wait: the frontend server, once listening
export async function start(): Promise<Server<WSData>> {
  loadPlatform();
  files.init();
  users.Init();
  store.start();
  migrateConfig();
  update.onFinish(rememberChain);
  update.onFailed(() => setUpdating(false));
  setInterval(reapShells, 60000);
  setInterval(() => {
    reapApps();
    reapWeb();
    reapDesks((k) => appsBusy(k) || webBusy(k));
  }, 60000);

  // FRONTEND_BIND: one address alone, for a test mesh of several hosts on loopback
  const srv = proxyServe(port, meshOnly(appHandler), false, env("FRONTEND_BIND") || undefined);
  logf("[frontend] listening on port %d as %s, version %s", srv.port, selfHost || "an unnamed host", Version());
  recordPlatform();
  update.restoreChain();
  void homesync.start(homeRemote);
  webapps.Start(tailnetIP, port);
  startApps();
  catalog.start({
    ip: () => tailnetIP(selfHost),
    hosts: stackHosts,
    installed: () => new Set(store.list("etc/stacks").map((f) => f.replace(/\.json$/, ""))),
  });
  // the installed services: this host's copies brought to the mesh's wants
  stacks.Start({
    defOf: catalog.defOf,
    ipOf: tailnetIP,
    hosts: () => peers.tailnet().flatMap((d) => (d.phosphorus === true && typeof d.name === "string" ? [d.name] : [])),
  });
  setStackRows(stacks.webRows);
  ingressListen(ingressPort, appHandler, { pass: users.Pass, issuers: users.Issuers });
  stats.hooks.self = () => ({ host: selfHost, platform: getPlatform(), version: Version() });
  stats.hooks.peers = peers.peerIPs;
  await stats.init();
  initMCP();
  peers.start({
    platform: getPlatform,
    ownLock: update.ownLock,
    hostServices,
    own: ownState,
    self: () => ({ version: Version(), bootId: bootID }),
  });
  startHA();
  startEdge();
  startMeshDNS();
  // the domain this frontend was started with changed: run starts it again with the
  // new one, a moment later so the answer to the page that set it gets out
  let restarting = false;
  store.watch((rel) => {
    if (rel !== services.domainRel || restarting) return;
    const name = services.domain()?.name ?? "";
    if (name === baseDomain) return;
    restarting = true;
    logf("[frontend] the domain is now %s, restarting with it", name || "unset");
    setTimeout(() => {
      stopEdge();
      stopMeshDNS();
      process.exit(RestartExit);
    }, 1500);
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
  stopEdge();
  stopMeshDNS();
  // each stack this host runs handed over while its final pull can still be served
  await stopHA();
  await stopApps();
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
    model: Summary,
    lock: update.meshLock,
    chain: () => update.chainStatus() ?? peers.chain(),
    actions: {
      agentModel: (agent, slot, m) => {
        const [st, out] = Assign({ agent, slot, model: m });
        if (st === 200) markHot();
        return [st, out];
      },
      update: (action, admin, only) => {
        markHot();
        const [st, body] = chainAction(action, admin, only);
        if (st === 409) return [409, { error: "no update started here to " + action }];
        return [st, body];
      },
      files: filesCall,
      copy: (c: Caller | undefined, from: Loc, to: Loc, move: boolean) =>
        copyTree(c, { host: from[0], share: from[1], path: from[2] }, { host: to[0], share: to[1], path: to[2] }, move),
      logs: hostLogsOn,
      op: (host, op, p) => {
        if (op === "mesh_health") return meshHealth().then((h) => [200, h] as [number, any]);
        if (op === "update_history") return [200, chainHistory()];
        let wait = 100000;
        if (op === "exec" || op === "exec_via" || op === "shell") wait = (num(p?.timeout) + 30) * 1000;
        return opOn(host, op, p, wait);
      },
      config: hostConfig,
      userUI,
      userUIAsync,
      service: svcRequest,
      stacks: stacksOp,
      apps: appsOp,
      modelColor,
    },
    locate: files.locate,
  });
}
