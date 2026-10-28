import { expect, test } from "bun:test";

process.env.GAME_DNS_PORT = "0";
const { answer, Server, Zone } = await import("@phosphorus/gamedns");

// one query: id, flags, a single question
function query(name: string, qtype = 1, flags = 0x0100): Uint8Array {
  const labels = name.split(".").flatMap((l) => [l.length, ...Buffer.from(l)]);
  return new Uint8Array([
    0x12,
    0x34,
    flags >> 8,
    flags & 0xff,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    ...labels,
    0,
    qtype >> 8,
    qtype & 0xff,
    0,
    1,
  ]);
}
const lookup = (n: string) => (n === "valheim" ? "100.64.1.2" : "");

test("answer", () => {
  const q = query("Valheim." + Zone);
  const a = answer(q, lookup)!;
  // id kept, QR AA RD set, rcode 0, one question, one answer
  expect([...a.subarray(0, 12)]).toEqual([0x12, 0x34, 0x85, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
  expect([...a.subarray(12, q.length)]).toEqual([...q.subarray(12)]);
  expect([...a.subarray(q.length)]).toEqual([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 5, 0, 4, 100, 64, 1, 2]);
  // AAAA: no error, no answer; unknown: NXDOMAIN; another zone: REFUSED
  const aaaa = answer(query("valheim." + Zone, 28), lookup)!;
  expect([aaaa[3], aaaa[7], aaaa.length]).toEqual([0, 0, q.length]);
  expect(answer(query("nope." + Zone), lookup)![3]).toBe(3);
  expect(answer(query("a.b." + Zone), lookup)![3]).toBe(3);
  expect(answer(query("valheim.example"), lookup)![3]).toBe(5);
  // an unsupported opcode: NOTIMP; a response, a short or a torn packet: silence
  expect(answer(query("valheim." + Zone, 1, 0x0800), lookup)![3]).toBe(4);
  expect(answer(query("valheim." + Zone, 1, 0x8100), lookup)).toBeUndefined();
  expect(answer(new Uint8Array(5), lookup)).toBeUndefined();
  expect(answer(query("valheim." + Zone).subarray(0, 20), lookup)).toBeUndefined();
});

test("server binds and answers over udp", async () => {
  const notes: string[] = [];
  const s = new Server(lookup, (_k, m) => notes.push(m));
  s.bind("127.0.0.1");
  for (let i = 0; i < 100 && !s.port; i++) await Bun.sleep(10);
  expect(s.port).toBeGreaterThan(0);
  expect(notes[0]).toMatch(/^serving \.phosphorus names on 127\.0\.0\.1:\d+$/);
  const got = await new Promise<Uint8Array>(async (res) => {
    const c = await Bun.udpSocket({ socket: { data: (_s, b) => res(new Uint8Array(b)) } });
    c.send(query("valheim." + Zone), s.port, "127.0.0.1");
  });
  expect([...got.subarray(got.length - 4)]).toEqual([100, 64, 1, 2]);
  s.bind("");
  expect(s.port).toBe(0);
});
