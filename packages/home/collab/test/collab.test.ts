import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgrade, websocket, type WSData } from "@phosphorus/wsock";

// a share "0" on a temp dir, the home share absent
const dir = mkdtempSync(join(tmpdir(), "phos-collab-ws-"));
process.env.PHOSPHORUS_FILES_DIRS = dir;
process.env.PHOSPHORUS_FILES_PERMS = "rw";
process.env.HOME_FS = join(dir, "nohome");
const files = await import("@phosphorus/files");
const { Attach, Forward, Write } = await import("@phosphorus/collab");
const { sessions } = await import("../src/collab.ts");

const serve = (ready: (c: import("@phosphorus/wsock").Conn) => void) =>
  Bun.serve<WSData>({
    port: 0,
    fetch(req, server) {
      const c = { req, url: new URL(req.url), ip: "", ingress: false, server };
      if (upgrade(c, ready)) return;
      return new Response("no", { status: 404 });
    },
    websocket,
  });

// a client whose messages are taken one at a time
function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const queue: any[] = [];
  const waiting: ((m: any) => void)[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiting.shift();
    if (w) w(m);
    else queue.push(m);
  };
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise<any>((r) => waiting.push(r)));
  const opened = new Promise<void>((r) => (ws.onopen = () => r()));
  return { ws, next, opened, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

// written a second ago: a file changed this instant reads as still changing
function fixture(name: string, text: string) {
  const p = join(dir, name);
  writeFileSync(p, text);
  const quiet = new Date(Date.now() - 1000);
  utimesSync(p, quiet, quiet);
}

afterAll(() => {
  for (const s of sessions.values()) {
    clearTimeout(s.idle);
    clearTimeout(s.autosave);
  }
  sessions.clear();
  rmSync(dir, { recursive: true, force: true });
});

test("attach: init, join, op, save and resync as the Go protocol", async () => {
  fixture("a.txt", "hello");
  const srv = serve((c) => void Attach(c, "0", "a.txt", undefined));
  const cl = connect(srv.port!);
  await cl.opened;
  const init = await cl.next();
  expect(init).toEqual({ type: "init", text: "hello", v: 0, saved: 0, perms: "rw", people: [], you: init.you, eol: "\n" });
  cl.send({ type: "join", name: "ann", color: "#f00" });
  expect(await cl.next()).toEqual({ type: "people", people: [{ id: init.you, name: "ann", color: "#f00", pos: 0 }] });
  cl.send({ type: "op", base: 0, ops: ["X", 5], id: "k1" });
  expect(await cl.next()).toEqual({ type: "op", v: 1, ops: ["X", 5], id: "k1", by: "ann", agent: false, agentEdit: init.you });
  cl.send({ type: "save" });
  expect(await cl.next()).toEqual({ type: "saved", v: 1, by: "ann" });
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("Xhello");
  // a base older than the history or missing: the text sent back, the id null as Go's nil
  cl.send({ type: "op", base: 7, ops: [6] });
  expect(await cl.next()).toEqual({ type: "resync", text: "Xhello", v: 1, saved: 1, id: null });
  // an edit rebased over one it hadn't seen
  cl.send({ type: "op", base: 0, ops: [5, "!"], id: "k2" });
  expect(await cl.next()).toEqual({ type: "op", v: 2, ops: [6, "!"], id: "k2", by: "ann", agent: false, agentEdit: init.you });

  // an agent's write typed into the open session; the file just saved aged, as
  // one written this instant reads as still changing
  const quiet = new Date(Date.now() - 1000);
  utimesSync(join(dir, "a.txt"), quiet, quiet);
  const sh = files.shareOf("0")!;
  const done = Write(sh, "a.txt", { old: "hello", new: "hey", byName: "bot" });
  const people = await cl.next();
  expect(people.type).toBe("people");
  expect(people.people[1]).toEqual({ id: people.people[1].id, name: "bot", color: "", pos: 3, agent: true });
  const first = await cl.next();
  expect(first).toMatchObject({ type: "op", v: 3, ops: [3, -3, 1], by: "bot", agent: true, agentEdit: people.people[1].id });
  expect(String(first.id)).toMatch(/^agent-\d+$/);
  const [status, out] = await done;
  expect(status).toBe(200);
  expect(out).toMatchObject({ live: true, note: "typed into the open editor and saved" });
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("Xhey!");
  cl.ws.close();
  srv.stop(true);
});

test("forward relays a tab to another host", async () => {
  fixture("b.txt", "far");
  const far = serve((c) => void Attach(c, "0", "b.txt", undefined));
  const near = serve((c) => Forward(c, () => `ws://127.0.0.1:${far.port!}/`, ""));
  const cl = connect(near.port!);
  await cl.opened;
  cl.send({ type: "join", name: "bob", color: "" });
  const init = await cl.next();
  expect(init).toMatchObject({ type: "init", text: "far" });
  expect(await cl.next()).toEqual({ type: "people", people: [{ id: init.you, name: "bob", color: "", pos: 0 }] });
  cl.ws.close();
  far.stop(true);
  near.stop(true);
});

test("forward answers when the host can't be found", async () => {
  const near = serve((c) => Forward(c, async () => "", ""));
  const cl = connect(near.port!);
  await cl.opened;
  expect(await cl.next()).toEqual({ type: "error", error: "can't find that host on the tailnet" });
  near.stop(true);
});
