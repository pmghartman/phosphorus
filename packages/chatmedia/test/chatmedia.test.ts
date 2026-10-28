import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-media-"));
process.env.HOME_FS = dir;
process.env.STATE_DIR = join(dir, "state");
process.env.CHAT_MEDIA_MAX_MB = "1";
const M = await import("@phosphorus/chatmedia");
M.init();

const upload = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://x/api/chat/media", { method: "POST", body, headers });

test("clean", () => {
  const id = "0123456789abcdef0123456789abcdef";
  expect(M.clean(undefined)).toBeUndefined();
  expect(M.clean([])).toBeUndefined();
  expect(M.clean([{ host: "BAD", id }, { host: "torus", id: "short" }, "x"])).toBeUndefined();
  expect(M.clean([{ host: "torus", id, name: "", type: 7, size: "3" }])).toEqual([{ host: "torus", id, name: "file", type: "", size: 0 }]);
  const many = Array.from({ length: 10 }, () => ({ host: "torus", id, name: "a".repeat(300), type: "text/plain", size: 3 }));
  const out = M.clean(many)!;
  expect(out.length).toBe(8);
  expect(out[0]!.name.length).toBe(200);
});

test("save, serve, pull", async () => {
  const [st, b] = await M.save("torus", upload(new TextEncoder().encode("hello"), { "content-length": "5" }), "a/b\\c.txt", "Text/Plain");
  expect(st).toBe(200);
  expect(b).toMatchObject({ host: "torus", name: "a_b_c.txt", type: "text/plain", size: 5 });
  expect(M.valid("torus", b.id)).toBe(true);
  const r = M.serve("torus", b.id, false)!;
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("hello");
  expect(r.headers.get("content-type")).toBe("text/plain");
  expect(r.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''a_b_c.txt");
  expect(r.headers.get("content-security-policy")).toBe("sandbox");
  expect(JSON.parse(decodeURIComponent(r.headers.get("x-phosphorus-media")!))).toEqual({ name: "a_b_c.txt", type: "text/plain", size: 5 });
  const dl = M.serve("torus", b.id, true)!;
  expect([dl.headers.get("content-type"), dl.headers.get("content-disposition")]).toEqual(["application/octet-stream", "attachment; filename*=UTF-8''a_b_c.txt"]);
  expect(M.serve("torus", "0123456789abcdef0123456789abcdef", false)).toBeUndefined();
  expect(M.serve("nope", b.id, false)).toBeUndefined();

  // over the cap: by its length up front, or found out while streaming
  expect((await M.save("torus", upload(new Uint8Array(1), { "content-length": String(M.MaxFile + 1) }), "x", ""))[0]).toBe(413);
  const big = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(300 * 1024));
      c.close();
    },
  });
  expect(await M.save("torus", upload(big), "x", "")).toEqual([413, { error: "over 1MB" }]);

  // pulled from a peer that answers as serve() does
  const peer = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      expect(u.search).toBe("?hop=1");
      const [, , , , host, id] = u.pathname.split("/");
      return M.serve(host!, id!, false) ?? new Response("not found", { status: 404 });
    },
  });
  expect(await M.pull("torus", b.id, "127.0.0.1", peer.port!)).toBe(true);
  expect(await M.pull("torus", "0123456789abcdef0123456789abcdef", "127.0.0.1", peer.port!)).toBe(false);
  peer.stop(true);
});
