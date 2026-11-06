// devices in one process over a fake network: handshakes, data, the hub
// forwarding, direct paths and their fallback, rekeys and replays
import { expect, test } from "bun:test";
import { Device, type PeerConfig } from "../src/device.ts";
import { v4 } from "../src/ip.ts";
import { initiation, stampMacs } from "../src/noise.ts";
import { b64, keyPair, Static } from "../src/x25519.ts";

// an IPv4 packet from src to dst carrying text
function packet(src: string, dst: string, text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const p = new Uint8Array(20 + body.length);
  const v = new DataView(p.buffer);
  p[0] = 0x45;
  v.setUint16(2, p.length);
  p[8] = 64;
  p[9] = 17;
  v.setUint32(12, v4(src)!);
  v.setUint32(16, v4(dst)!);
  p.set(body, 20);
  return p;
}
const textOf = (p: Uint8Array) => new TextDecoder().decode(p.subarray(20));

class Net {
  clock = 1_000_000;
  devs = new Map<string, Device>();
  got = new Map<string, string[]>();
  q: [Uint8Array, string, string][] = [];
  // endpoints whose datagrams are lost
  cut = new Set<string>();
  sent: { from: string; to: string; type: number }[] = [];

  add(ep: string, address: string, hub = false) {
    const kp = keyPair();
    this.got.set(ep, []);
    const d = new Device({
      key: kp.priv,
      address,
      hub,
      now: () => this.clock,
      send: (msg, to) => {
        this.sent.push({ from: ep, to, type: msg[0]! });
        if (!this.cut.has(to) && !this.cut.has(ep)) this.q.push([msg, to, ep]);
      },
      deliver: (pkt) => this.got.get(ep)!.push(textOf(pkt)),
    });
    this.devs.set(ep, d);
    return d;
  }
  pump() {
    for (let i = 0; this.q.length && i < 10_000; i++) {
      const [m, to, from] = this.q.shift()!;
      this.devs.get(to)?.receive(m, from);
    }
  }
  advance(ms: number) {
    for (let t = 0; t < ms; t += 1000) {
      this.clock += 1000;
      for (const d of this.devs.values()) d.tick();
      this.pump();
    }
  }
}

const peer = (d: Device, allowed: string[], endpoints: string[] = [], more: Partial<PeerConfig> = {}): PeerConfig => ({
  key: d.publicKey,
  allowed,
  endpoints,
  ...more,
});

test("two peers handshake, and data flows both ways", () => {
  const n = new Net();
  const a = n.add("a:1", "100.64.0.1");
  const b = n.add("b:1", "100.64.0.2");
  a.setPeers([peer(b, ["100.64.0.2/32"], ["b:1"])]);
  b.setPeers([peer(a, ["100.64.0.1/32"])]);
  a.send(packet("100.64.0.1", "100.64.0.2", "hello b"));
  n.pump();
  expect(n.got.get("b:1")).toEqual(["hello b"]);
  b.send(packet("100.64.0.2", "100.64.0.1", "hello a"));
  n.pump();
  expect(n.got.get("a:1")).toEqual(["hello a"]);
  expect(b.status()[0]!.endpoint).toBe("a:1");
});

test("a source outside the peer's allowed ips is dropped", () => {
  const n = new Net();
  const a = n.add("a:1", "100.64.0.1");
  const b = n.add("b:1", "100.64.0.2");
  a.setPeers([peer(b, ["100.64.0.2/32"], ["b:1"])]);
  b.setPeers([peer(a, ["100.64.0.1/32"])]);
  a.send(packet("100.64.0.9", "100.64.0.2", "spoofed"));
  n.pump();
  expect(n.got.get("b:1")).toEqual([]);
});

test("a replayed data message is refused", () => {
  const n = new Net();
  const a = n.add("a:1", "100.64.0.1");
  const b = n.add("b:1", "100.64.0.2");
  a.setPeers([peer(b, ["100.64.0.2/32"], ["b:1"])]);
  b.setPeers([peer(a, ["100.64.0.1/32"])]);
  a.send(packet("100.64.0.1", "100.64.0.2", "once"));
  n.pump();
  let last: Uint8Array | undefined;
  const orig = n.q.push.bind(n.q);
  n.q.push = (x) => {
    if (x[0][0] === 4) last = x[0];
    return orig(x);
  };
  a.send(packet("100.64.0.1", "100.64.0.2", "twice?"));
  n.pump();
  b.receive(last!, "a:1");
  expect(n.got.get("b:1")).toEqual(["once", "twice?"]);
});

test("a hub forwards between peers that only know it", () => {
  const n = new Net();
  const hub = n.add("hub:1", "100.64.0.100", true);
  const a = n.add("a:1", "100.64.0.1");
  const b = n.add("b:1", "100.64.0.2");
  hub.setPeers([peer(a, ["100.64.0.1/32"]), peer(b, ["100.64.0.2/32"])]);
  a.setPeers([peer(hub, ["100.64.0.0/10"], ["hub:1"], { keepalive: 25 })]);
  b.setPeers([peer(hub, ["100.64.0.0/10"], ["hub:1"], { keepalive: 25 })]);
  n.advance(2000);
  a.send(packet("100.64.0.1", "100.64.0.2", "via hub"));
  n.pump();
  expect(n.got.get("b:1")).toEqual(["via hub"]);
  b.send(packet("100.64.0.2", "100.64.0.100", "to the hub itself"));
  n.pump();
  expect(n.got.get("hub:1")).toEqual(["to the hub itself"]);
});

test("a direct path carries traffic once up, and the hub again when it dies", () => {
  const n = new Net();
  const hub = n.add("hub:1", "100.64.0.100", true);
  const a = n.add("a:1", "100.64.0.1");
  const b = n.add("b:1", "100.64.0.2");
  hub.setPeers([peer(a, ["100.64.0.1/32"]), peer(b, ["100.64.0.2/32"])]);
  const viaHub = (d: Device) => peer(d, ["100.64.0.0/10"], ["hub:1"], { keepalive: 25 });
  a.setPeers([viaHub(hub), peer(b, ["100.64.0.2/32"], ["nowhere:9", "b:1"], { direct: true })]);
  b.setPeers([viaHub(hub), peer(a, ["100.64.0.1/32"], ["a:1"], { direct: true })]);
  // the hub's sessions up, no direct one yet: the hub carries it
  n.cut.add("nowhere:9");
  n.advance(1000);
  a.send(packet("100.64.0.1", "100.64.0.2", "first"));
  n.pump();
  expect(n.got.get("b:1")).toEqual(["first"]);
  n.advance(20_000);
  n.sent = [];
  a.send(packet("100.64.0.1", "100.64.0.2", "direct"));
  n.pump();
  expect(n.got.get("b:1")).toEqual(["first", "direct"]);
  expect(n.sent.some((s) => s.from === "a:1" && s.to === "b:1" && s.type === 4)).toBe(true);
  // the direct path lost: its sessions age out and the hub takes over
  n.cut.add("b:1");
  n.advance(200_000);
  n.cut.delete("b:1");
  a.setPeers([viaHub(hub), peer(b, ["100.64.0.2/32"], ["nowhere:9"], { direct: true })]);
  n.advance(200_000);
  a.send(packet("100.64.0.1", "100.64.0.2", "hub again"));
  n.pump();
  expect(n.got.get("b:1")!.at(-1)).toBe("hub again");
});

test("sessions renew after the rekey time without losing data", () => {
  const n = new Net();
  const a = n.add("a:1", "100.64.0.1");
  const b = n.add("b:1", "100.64.0.2");
  a.setPeers([peer(b, ["100.64.0.2/32"], ["b:1"], { keepalive: 25 })]);
  b.setPeers([peer(a, ["100.64.0.1/32"])]);
  for (let i = 0; i < 12; i++) {
    a.send(packet("100.64.0.1", "100.64.0.2", `m${i}`));
    n.pump();
    n.advance(60_000);
  }
  expect(n.got.get("b:1")).toEqual(Array.from({ length: 12 }, (_, i) => `m${i}`));
  expect(n.sent.filter((s) => s.type === 1).length).toBeGreaterThan(4);
});

test("an initiation from an unknown key, or with a bad mac1, is ignored", () => {
  const n = new Net();
  const b = n.add("b:1", "100.64.0.2");
  b.setPeers([]);
  const stranger = new Static(keyPair().priv);
  const bPub = Uint8Array.from(Buffer.from(b.publicKey, "base64"));
  const made = initiation(stranger, bPub, 7)!;
  stampMacs(made.msg, bPub);
  b.receive(made.msg, "x:1");
  const bad = initiation(stranger, bPub, 8)!;
  b.receive(bad.msg, "x:1");
  n.pump();
  expect(n.sent).toEqual([]);
  expect(b64(bPub)).toBe(b.publicKey);
});
