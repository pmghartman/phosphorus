// the loop against a fake tailscale (a shim on PATH reading a status file) and
// fake peers on 127.0.0.x, each a Bun.serve on the frontend port
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const linux = process.platform === "linux";
const dir = mkdtempSync(join(tmpdir(), "phos-mesh-"));
const statusFile = join(dir, "status.json");
mkdirSync(join(dir, "bin"));
writeFileSync(join(dir, "bin", "tailscale"), `#!/bin/sh\n[ -f "$TS_STATUS_FILE" ] || exit 1\ncat "$TS_STATUS_FILE"\n`);
chmodSync(join(dir, "bin", "tailscale"), 0o755);
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port!;
probe.stop(true);
process.env.PATH = `${join(dir, "bin")}:${process.env.PATH}`;
process.env.TS_STATUS_FILE = statusFile;
process.env.STATE_DIR = dir;
process.env.SELF_HOST = "self";
process.env.FRONTEND_PORT = String(port);
process.env.SERVICES_FILE = join(dir, "none.export");
process.env.GAME_DNS_PORT = "0";
// three misses call a peer gone; hot for the whole run, discovery refreshed each second
process.env.POLL_INTERVAL_MS = "500";
process.env.POLL_HOT_MS = "600000";
delete process.env.TS_API_KEY;
const mesh = await import("@phosphorus/mesh");

type Node = { DNSName: string; TailscaleIPs: string[]; Online: boolean; OS: string; Tags?: string[] };
const node = (name: string, ip: string, online = true, OS = "linux", Tags?: string[]): Node => ({ DNSName: `${name}.tail1234.ts.net.`, TailscaleIPs: [ip, "fd7a::" + ip.split(".")[3]], Online: online, OS, ...(Tags ? { Tags } : {}) });
const tailscale = (peers: Record<string, Node>, self = "self") => writeFileSync(statusFile, JSON.stringify({ Self: { DNSName: `${self}.tail1234.ts.net.`, TailscaleIPs: ["127.0.0.1", "fd7a::1"] }, Peer: peers }));

// a peer's frontend, its snapshot filtered by since as the server's is
function peer(ip: string, snap: Record<string, any>) {
  const since: string[] = [];
  let s = serve();
  function serve() {
    return Bun.serve({
      hostname: ip,
      port,
      fetch(req) {
        const q = new URL(req.url).searchParams.get("since") ?? "";
        since.push(q);
        return Response.json({ ...snap, chat: (snap.chat ?? []).filter((m: any) => m.seq > Number(q)) });
      },
    });
  }
  return { snap, since, stop: () => s.stop(true), restart: () => void (s = serve()) };
}

async function until(cond: () => boolean, what: string, ms = 6000) {
  for (let i = 0; i < ms / 20; i++) {
    if (cond()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for " + what);
}

test("hostOf", () => {
  expect(mesh.hostOf("Mulab-01.tail1234.ts.net.")).toBe("mulab-01");
  expect(mesh.hostOf("my_box.example")).toBe("my-box");
  expect(mesh.hostOf("--odd--")).toBe("odd");
  expect(mesh.hostOf("")).toBe("");
});

test.skipIf(!linux)("discovery, polling, offline tracking and the views", async () => {
  const nodes: Record<string, Node> = {
    nb: node("bravo", "127.0.0.3"),
    na: node("alpha", "127.0.0.2"),
    np: node("phone", "127.0.0.4", false, "iOS"),
    ng: node("guest", "127.0.0.5", true, "android", ["tag:guest"]),
  };
  tailscale(nodes);
  const alpha = peer("127.0.0.2", {
    self: { host: "alpha", platform: "linux", version: "1.2" },
    presence: [{ user: "ann" }],
    chat: [{ seq: 1, text: "hi" }, { seq: 2, text: "there" }],
    lock: {},
    chain: { initiator: "alpha", startedAt: "2026-01-01T00:00:00Z" },
    git: { host: "alpha", role: "master" },
    model: { host: "alpha", name: "chimp" },
    sysDigest: "sys-a",
    services: [{ name: "web", port: 8080, scheme: "http", mode: "path" }, { name: "valheim", port: 2456, type: "game", status: "online" }],
  });
  const bravo = peer("127.0.0.3", {
    self: { host: "bravo", platform: "windows", version: "1.3" },
    presence: [],
    chat: [],
    lock: null,
    chain: { initiator: "bravo", startedAt: "2026-01-02T00:00:00Z" },
    git: { host: "bravo", role: "replica" },
    model: null,
    sysDigest: "sys-b",
    services: [{ name: "api", port: 9090, scheme: "https", mode: "subdomain", public: true }, { name: "valheim", port: 2456, type: "game", status: "offline" }],
  });
  const chats: any[][] = [];
  const presences: Record<string, any[]>[] = [];
  mesh.start({ mergeChat: (c) => void chats.push(c), mergePresence: (p) => void presences.push(p), platform: () => "testos", ownLock: () => null });
  await until(() => mesh.routes().length === 4, "both peers' routes");

  expect(readFileSync(join(dir, "self-host"), "utf8")).toBe("self");
  expect(mesh.routes().map((r) => `${r.host}/${r.name}`)).toEqual(["alpha/valheim", "alpha/web", "bravo/api", "bravo/valheim"]);
  expect(mesh.routes()[1]).toEqual({ name: "web", port: 8080, scheme: "http", mode: "path", host: "alpha" });
  // the guest and the phone listed from tailscale alone, the phone offline
  expect(mesh.tailnet()).toEqual([
    { name: "self", os: "testos", phosphorus: true, phosphorusSeen: true },
    { name: "alpha", os: "linux", phosphorus: true, phosphorusSeen: true, version: "1.2" },
    { name: "bravo", os: "windows", phosphorus: true, phosphorusSeen: true, version: "1.3" },
    { name: "guest", os: "android", phosphorus: false, phosphorusSeen: false, version: "" },
  ]);
  expect(mesh.peerIPs()).toEqual({ alpha: "127.0.0.2", bravo: "127.0.0.3" });
  expect(Object.keys(mesh.offlineMS())).toEqual(["phone"]);
  expect(mesh.offlineMS().phone).toBeGreaterThanOrEqual(0);
  // a lock without an initiator is none; the chain the newest started
  expect(mesh.lock()).toBeNull();
  expect(mesh.chain()).toEqual({ initiator: "bravo", startedAt: "2026-01-02T00:00:00Z" });
  expect(mesh.peerGit()).toEqual([{ host: "alpha", role: "master" }, { host: "bravo", role: "replica" }]);
  expect(mesh.peerModel()).toEqual([{ host: "alpha", name: "chimp" }]);
  expect(mesh.peerSys()).toEqual([{ host: "alpha", digest: "sys-a" }, { host: "bravo", digest: "sys-b" }]);
  // chat handed on once, the next poll asking from its last seq; presence on change only
  await until(() => alpha.since.includes("2"), "a poll since seq 2");
  expect(chats).toEqual([[{ seq: 1, text: "hi" }, { seq: 2, text: "there" }]]);
  expect(presences).toEqual([{ alpha: [{ user: "ann" }] }]);
  expect(alpha.since[0]).toBe("0");
  // this tailnet's own devices trusted, a guest and a stranger not
  expect(await mesh.trusted("127.0.0.3")).toBe(true);
  expect(await mesh.trusted("fd7a::3")).toBe(true);
  expect(await mesh.trusted("127.0.0.5")).toBe(false);
  expect(await mesh.trusted("9.9.9.9")).toBe(false);
  expect(readFileSync(join(dir, "ssh_config"), "utf8")).toBe(
    "# auto-generated by the frontend, do not edit, changes are overwritten\n\nHost alpha\n\tHostName 127.0.0.2\n\nHost bravo\n\tHostName 127.0.0.3\n\nHost guest\n\tHostName 127.0.0.5\n\nHost phone\n\tHostName 127.0.0.4\n",
  );

  // a peer's lock holds the chain; a bad row keeps its last good list
  bravo.snap.lock = { initiator: "bravo", hosts: ["alpha"] };
  bravo.snap.services = [{ name: "api", port: 9090, scheme: "ftp", mode: "subdomain" }];
  await until(() => mesh.lock() !== null, "bravo's lock");
  expect(mesh.chain()).toEqual({ initiator: "bravo", hosts: ["alpha"] });
  expect(mesh.routes().map((r) => `${r.host}/${r.name}`)).toEqual(["alpha/valheim", "alpha/web", "bravo/api", "bravo/valheim"]);

  // tailscale's flag alone drops nothing: alpha polled on while it answers
  nodes.na = node("alpha", "127.0.0.2", false);
  tailscale(nodes);
  await until(() => Object.keys(mesh.offlineMS()).includes("alpha"), "alpha offline per tailscale");
  await Bun.sleep(1200);
  expect(mesh.tailnet()[1]).toEqual({ name: "alpha", os: "linux", phosphorus: true, phosphorusSeen: true, version: "1.2" });
  expect(mesh.peerIPs().alpha).toBe("127.0.0.2");

  // alpha stops answering: three misses retire its routes, the device kept
  // with the version it last reported, its git view aged out, its digest kept
  nodes.na = node("alpha", "127.0.0.2");
  tailscale(nodes);
  alpha.stop();
  await until(() => !mesh.routes().some((r) => r.host === "alpha"), "alpha retired");
  expect(mesh.tailnet()[1]).toEqual({ name: "alpha", os: "linux", phosphorus: false, phosphorusSeen: true, version: "1.2" });
  expect(mesh.peerIPs()).toEqual({ bravo: "127.0.0.3" });
  expect(mesh.peerSys()).toEqual([{ host: "alpha", digest: "sys-a" }, { host: "bravo", digest: "sys-b" }]);
  await until(() => mesh.peerGit().length === 1, "alpha's git aged out");
  expect(mesh.peerGit()).toEqual([{ host: "bravo", role: "replica" }]);
  // back: the quiet retry finds it
  alpha.restart();
  await until(() => mesh.routes().some((r) => r.host === "alpha"), "alpha back");
  expect(mesh.tailnet()[1]!.phosphorus).toBe(true);

  // tailscaled unreachable: the last peers kept
  rmSync(statusFile);
  await Bun.sleep(1500);
  expect(mesh.routes().length).toBe(4);
  expect(mesh.tailnet().length).toBe(4);

  // bravo leaves the tailnet
  delete nodes.nb;
  tailscale(nodes);
  await until(() => !mesh.tailnet().some((d) => d.name === "bravo"), "bravo gone");
  expect(mesh.routes().map((r) => r.host)).toEqual(["alpha", "alpha"]);
  expect(mesh.peerSys()).toEqual([{ host: "alpha", digest: "sys-a" }]);
  expect(mesh.lock()).toBeNull();
  expect(mesh.chain()).toEqual({ initiator: "alpha", startedAt: "2026-01-01T00:00:00Z" });
  alpha.stop();
  bravo.stop();
}, 40_000);
