import { expect, test } from "bun:test";
import {
  answer,
  build,
  limiter,
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
  expect(caa.answer.map((r) => [(r.data as any).tag, (r.data as any).value])).toEqual([
    ["issue", "letsencrypt.org"],
    ["issuewild", "letsencrypt.org"],
  ]);
  // with the account known, issuance tied to it and to dns-01
  const acct = "https://acme-v02.api.letsencrypt.org/acme/acct/123";
  const bound = answer(build({ ...spec, acmeAccount: acct }), ask("example.com", Type.CAA));
  expect(bound.answer.map((r) => (r.data as any).value)).toEqual(
    Array(2).fill(`letsencrypt.org; accounturi=${acct}; validationmethods=dns-01`),
  );
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
  // ANY: one record set, never the whole name
  expect(parsed.answer.map((x) => x.data.type)).toEqual([1, 1]);
  expect(answer(z, ask("_acme-challenge.example.com", Type.ANY)).answer.map((x) => x.data.type)).toEqual([16, 16]);
  const soa = parseReply(writeReply(answer(z, ask("example.com", Type.SOA)))).answer[0]!.data as any;
  expect(soa.serial).toBe(7);
  expect(soa.mname).toBe("ns1.example.com");
  // an asker's EDNS size held to 1232
  const big = writeQuery(2, "example.com", Type.A);
  big.set([0xff, 0xff], big.length - 8);
  expect(parseQuery(big)!.edns).toBe(1232);
  const cut = parseReply(writeReply(r, 60));
  expect(cut.tc).toBe(true);
  expect(cut.answer).toHaveLength(0);
  // a query with a compression pointer in its name still reads
  const raw = writeQuery(9, "a.example.com", Type.A);
  const ptr = new Uint8Array(raw.length + 4);
  ptr.set(raw);
  expect(parseQuery(ptr)!.question!.name).toBe("a.example.com");
  // a name past 255 bytes refused
  const long = writeQuery(3, Array(5).fill("x".repeat(60)).join("."), Type.A);
  expect(parseQuery(long)!.bad).toBe("malformed");
});

test("the UDP rate limit: a burst, then every other reply truncated and the rest dropped", () => {
  const allow = limiter(10, 3, 2);
  const at = 1000;
  expect([1, 2, 3].map(() => allow("198.51.100.7", at))).toEqual(["send", "send", "send"]);
  // the same /24 shares the bucket, another network has its own
  expect([allow("198.51.100.9", at), allow("198.51.100.7", at)]).toEqual(["drop", "tc"]);
  expect(allow("192.0.2.1", at)).toBe("send");
  // refilled at the rate
  expect(allow("198.51.100.7", at + 100)).toBe("send");
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
  // two queries pipelined in one TCP write, both answered
  const replies = await new Promise<number[]>((done, fail) => {
    const ids: number[] = [];
    let got = new Uint8Array(0);
    const frame = (q: Uint8Array) => new Uint8Array([q.length >> 8, q.length & 0xff, ...q]);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(c) {
          c.write(
            new Uint8Array([
              ...frame(writeQuery(11, "a.example.com", Type.A)),
              ...frame(writeQuery(12, "b.example.com", Type.A)),
            ]),
          );
        },
        data(c, chunk) {
          got = new Uint8Array([...got, ...chunk]);
          while (got.length >= 2 && got.length >= 2 + ((got[0]! << 8) | got[1]!)) {
            const n = (got[0]! << 8) | got[1]!;
            ids.push(parseReply(got.subarray(2, 2 + n)).id);
            got = got.slice(2 + n);
          }
          if (ids.length === 2) {
            c.end();
            done(ids);
          }
        },
        error(_c, e) {
          fail(e);
        },
      },
    }).catch(fail);
  });
  expect(replies).toEqual([11, 12]);
  s.close();
});

test("an admin's records: A, AAAA, MX, TXT, and a CNAME standing for its name, followed in the zone", () => {
  const z = build({
    ...spec,
    records: [
      { name: "", type: "MX", value: "mail.example.com", priority: 5 },
      { name: "", type: "TXT", value: "v=spf1 mx -all" },
      { name: "mail", type: "A", value: "198.51.100.25" },
      { name: "mail", type: "AAAA", value: "2001:db8::25" },
      { name: "www", type: "CNAME", value: "mail.example.com" },
      { name: "shop", type: "CNAME", value: "shops.example.net" },
    ],
  });
  const mx = answer(z, ask("example.com", Type.MX));
  expect(mx.answer.map((r) => [(r.data as any).priority, (r.data as any).target])).toEqual([[5, "mail.example.com"]]);
  expect(mx.additional.map((r) => (r.data as any).ip)).toEqual(["198.51.100.25"]);
  // the custom name's own records, the wildcard's never
  expect(answer(z, ask("mail.example.com", Type.A)).answer.map((r) => (r.data as any).ip)).toEqual(["198.51.100.25"]);
  expect(answer(z, ask("mail.example.com", Type.AAAA)).answer).toHaveLength(1);
  expect(answer(z, ask("www.example.com", Type.A)).answer.map((r) => r.data.type)).toEqual([Type.CNAME, Type.A]);
  const shop = answer(z, ask("shop.example.com", Type.A));
  expect(shop.answer.map((r) => (r.data as any).target)).toEqual(["shops.example.net"]);
  // over the wire and back
  expect(parseReply(writeReply(mx)).answer[0]!.data).toEqual({
    type: Type.MX,
    priority: 5,
    target: "mail.example.com",
  });
  const www = answer(z, ask("www.example.com", Type.A));
  expect(parseReply(writeReply(www)).answer[0]!.data).toEqual({ type: Type.CNAME, target: "mail.example.com" });
});

test("a question outside the zone forwarded, the answer handed back whole", async () => {
  const other = build({ ...spec, domain: "other.test" });
  const s = await serve({
    addrs: ["127.0.0.1"],
    port: 0,
    zone: () => build(spec),
    forward: async (q) => writeReply(answer(other, parseQuery(q)!)),
  });
  try {
    const r = await query({ server: "127.0.0.1", port: s.port, name: "x.other.test", type: Type.A, timeoutMs: 2000 });
    expect(r.answer).toHaveLength(2);
    const own = await query({ server: "127.0.0.1", port: s.port, name: "example.com", type: Type.A, timeoutMs: 2000 });
    expect(own.aa).toBe(true);
  } finally {
    s.close();
  }
});
