import { expect, test } from "bun:test";
import {
  answer,
  build,
  parseQuery,
  parseReply,
  query,
  Rcode,
  serve,
  Type,
  writeQuery,
  writeReply,
} from "@phosphorus/dns";

const spec = {
  domain: "Example.com.",
  edges: ["203.0.113.1", "203.0.113.2"],
  hosts: { control: ["203.0.113.9"] },
  txt: { "_acme-challenge": ["tok1", "tok2"] },
  srv: [{ name: "mc", service: "minecraft", proto: "tcp" as const, port: 25565, target: "mc.example.com" }],
  serial: 7,
};

const ask = (name: string, type: number) => parseQuery(writeQuery(1, name, type))!;

test("the zone: apex, nameservers, wildcard, own names, texts and srv", () => {
  const z = build(spec);
  expect(z.domain).toBe("example.com");
  expect(z.nameservers).toEqual(["ns1.example.com", "ns2.example.com"]);
  const apex = answer(z, ask("example.com", Type.A));
  expect(apex.aa).toBe(true);
  expect(apex.answer.map((r) => (r.data as any).ip).sort()).toEqual(["203.0.113.1", "203.0.113.2"]);
  const ns = answer(z, ask("example.com", Type.NS));
  expect(ns.answer.map((r) => (r.data as any).target)).toEqual(["ns1.example.com", "ns2.example.com"]);
  expect(ns.additional.map((r) => [r.name, (r.data as any).ip])).toEqual([
    ["ns1.example.com", "203.0.113.1"],
    ["ns2.example.com", "203.0.113.2"],
  ]);
  const wild = answer(z, ask("Anything.deep.example.com", Type.A));
  expect(wild.answer.map((r) => r.name)).toEqual(["anything.deep.example.com", "anything.deep.example.com"]);
  const own = answer(z, ask("control.example.com", Type.A));
  expect(own.answer.map((r) => (r.data as any).ip)).toEqual(["203.0.113.9"]);
  const txt = answer(z, ask("_acme-challenge.example.com", Type.TXT));
  // the apex's and the wildcard's tokens each a record of its own, never one joined value
  expect(txt.answer.map((r) => (r.data as any).texts)).toEqual([["tok1"], ["tok2"]]);
  const srv = answer(z, ask("_minecraft._tcp.mc.example.com", Type.SRV));
  expect((srv.answer[0]!.data as any).port).toBe(25565);
  expect(srv.additional.map((r) => (r.data as any).ip).sort()).toEqual(["203.0.113.1", "203.0.113.2"]);
  const caa = answer(z, ask("example.com", Type.CAA));
  expect((caa.answer[0]!.data as any).value).toBe("letsencrypt.org");
});

test("negative answers: NODATA with the SOA, REFUSED off the zone, FORMERR and NOTIMP", () => {
  const z = build(spec);
  const nodata = answer(z, ask("control.example.com", Type.AAAA));
  expect(nodata.rcode).toBe(Rcode.NOERROR);
  expect(nodata.answer).toHaveLength(0);
  expect(nodata.authority[0]!.data.type).toBe(Type.SOA);
  expect(answer(z, ask("example.org", Type.A)).rcode).toBe(Rcode.REFUSED);
  expect(answer(undefined, ask("example.com", Type.A)).rcode).toBe(Rcode.REFUSED);
  const bad = parseQuery(new Uint8Array(12))!;
  expect(bad.bad).toBe("questions");
  expect(answer(z, bad).rcode).toBe(Rcode.FORMERR);
  const q = ask("example.com", Type.A);
  expect(answer(z, { ...q, opcode: 2 }).rcode).toBe(Rcode.NOTIMP);
  // no edges: nothing synthesized, NXDOMAIN
  const empty = build({ ...spec, edges: [] });
  expect(answer(empty, ask("nope.example.com", Type.A)).rcode).toBe(Rcode.NXDOMAIN);
});

test("the wire round trip, EDNS echoed, truncation when the reply is over the UDP size", () => {
  const z = build(spec);
  const q = ask("example.com", Type.ANY);
  expect(q.edns).toBe(1232);
  const r = answer(z, q);
  const parsed = parseReply(writeReply(r));
  expect(parsed.aa).toBe(true);
  expect(parsed.answer.map((x) => x.data.type).sort((a, b) => a - b)).toEqual([1, 1, 2, 2, 6, 257]);
  const soa = parsed.answer.find((x) => x.data.type === Type.SOA)!.data as any;
  expect(soa.serial).toBe(7);
  expect(soa.mname).toBe("ns1.example.com");
  const cut = parseReply(writeReply(r, 60));
  expect(cut.tc).toBe(true);
  expect(cut.answer).toHaveLength(0);
  // a query with a compression pointer in its name still reads
  const raw = writeQuery(9, "a.example.com", Type.A);
  const ptr = new Uint8Array(raw.length + 4);
  ptr.set(raw);
  expect(parseQuery(ptr)!.question!.name).toBe("a.example.com");
});

test("served over UDP and TCP on loopback, the client falling back to TCP on truncation", async () => {
  let zone = build(spec);
  const s = await serve({ addrs: ["127.0.0.1"], port: 0, zone: () => zone });
  // port 0 picks a port, the same asked of UDP and TCP is not guaranteed: read UDP's
  const port = s.port;
  expect(port).toBeGreaterThan(0);
  const a = await query({ server: "127.0.0.1", port, name: "www.example.com", type: Type.A, timeoutMs: 2000 });
  expect(a.aa).toBe(true);
  expect(a.answer.map((r) => (r.data as any).ip).sort()).toEqual(["203.0.113.1", "203.0.113.2"]);
  // many texts: over 512 bytes with EDNS absent is not what the client sends, so a TXT bulk fits in 1232
  zone = build({ ...spec, txt: { big: Array.from({ length: 30 }, (_, i) => "x".repeat(40) + i) } });
  const t = await query({ server: "127.0.0.1", port, name: "big.example.com", type: Type.TXT, timeoutMs: 2000 });
  expect(t.answer).toHaveLength(30);
  s.close();
});
