import { afterAll, expect, test } from "bun:test";
import { Server, type ServerChannel, utils } from "ssh2";
import { type Conn, dial, websocket, type WSData } from "@phosphorus/wsock";
import { attach, close, Ended, forward, type Opts, render, screens, sessionCount, Taken, typeIn } from "@phosphorus/term";

const dec = new TextDecoder();
const enc = new TextEncoder();
const clear = "\x1b[H\x1b[2J\x1b[3J";

test("render", async () => {
  const chunks = [enc.encode("hello\r\n\x1b[31mred\x1b[0m wide 漢字\r\n")];
  for (let i = 0; i < 10; i++) chunks.push(enc.encode("line\r\n"));
  const got = await render(chunks, 20, 5);
  expect(got.slice(0, 5)).toBe("hello");
  expect(got.split("\n")).toEqual(["hello", "red wide 漢字", ...Array(10).fill("line")]);
});

test("render keeps the last 120 lines, in place edits and resizes", async () => {
  const many: Uint8Array[] = [];
  for (let i = 1; i <= 300; i++) many.push(enc.encode(`l${i}\r\n`));
  const ls = (await render(many, 10, 5)).split("\n");
  // 120 of scrollback and the 5 rows, the last 120 of those, the cursor's blank row dropped
  expect(ls.length).toBe(119);
  expect(ls[0]).toBe("l182");
  expect(ls[118]).toBe("l300");
  // the cursor moved back over a line, a wide glyph's two cells, a blank screen
  expect(await render([enc.encode("abc\rX")], 10, 3)).toBe("Xbc");
  expect(await render([enc.encode("漢字")], 3, 1)).toBe("漢\n字");
  expect(await render([], 10, 3)).toBe("");
  expect(await render([enc.encode("a\r\n\r\n\r\n")], 10, 2)).toBe("a");
  expect(await render([enc.encode("\r\n\r\n")], 10, 2)).toBe("");
});

// --- a fake sshd: u/pw, a shell that echoes a few commands ------------------

type Fake = { port: number; winch: { cols: number; rows: number }[]; execs: string[]; ptys: { term: string; cols: number; rows: number }[]; stop: () => void };

function fakeSSHD(): Promise<Fake> {
  const f: Fake = { port: 0, winch: [], execs: [], ptys: [], stop: () => {} };
  const key = utils.generateKeyPairSync("ed25519");
  const srv = new Server({ hostKeys: [key.private] }, (client) => {
    client
      .on("authentication", (ctx) => {
        if (ctx.method === "password" && ctx.username === "u" && ctx.password === "pw") return ctx.accept();
        if (ctx.method === "keyboard-interactive") return ctx.prompt("Password: ", (a: string[]) => (a[0] === "pw" && ctx.username === "u" ? ctx.accept() : ctx.reject()));
        ctx.reject(["password", "keyboard-interactive"]);
      })
      .on("ready", () => {
        client.on("session", (accept) => {
          const s = accept();
          let pty = { term: "", cols: 0, rows: 0 };
          s.on("pty", (acc, _rej, info) => {
            pty = { term: info.term, cols: info.cols, rows: info.rows };
            f.ptys.push(pty);
            acc?.();
          });
          s.on("window-change", (acc, _rej, info) => {
            f.winch.push({ cols: info.cols, rows: info.rows });
            acc?.();
          });
          const shell = (ch: ServerChannel) => {
            ch.write(`shell ${pty.term} ${pty.cols}x${pty.rows}\r\n$ `);
            let line = "";
            ch.on("data", (d: Uint8Array) => {
              for (const c of dec.decode(d)) {
                if (c !== "\r") {
                  line += c;
                  ch.write(c);
                  continue;
                }
                ch.write("\r\n");
                if (line === "echo hi") ch.write("hi\r\n$ ");
                else if (line === "ask") ch.write("[sudo] password for u: ");
                else if (line === "exit") {
                  ch.exit(0);
                  ch.end();
                } else if (line === "slow") setTimeout(() => ch.write("late\r\n$ "), 600);
                else ch.write("$ ");
                line = "";
              }
            });
          };
          s.on("shell", (acc) => shell(acc()));
          s.on("exec", (acc, _rej, info) => {
            f.execs.push(info.command);
            shell(acc());
          });
        });
      })
      .on("error", () => {});
  });
  return new Promise((r) =>
    srv.listen(0, "127.0.0.1", () => {
      f.port = (srv.address() as { port: number }).port;
      f.stop = () => srv.close();
      r(f);
    }),
  );
}

// --- the frontend's /api/term/<host>, as a tab reaches it -------------------

function serveTerm(f: Fake, hop?: (q: URLSearchParams) => string) {
  return Bun.serve<WSData>({
    port: 0,
    fetch(req, server) {
      const q = new URL(req.url).searchParams;
      const o: Opts = {
        host: "box",
        sid: q.get("sid") ?? "",
        since: Number(q.get("since") ?? 0),
        resume: q.has("resume"),
        sshHost: "127.0.0.1",
        port: f.port,
        shell: q.get("shell") ?? "",
        auto: q.get("auto") === "1",
      };
      const ready = (c: Conn) => (hop && !q.has("hop") ? forward(c, "box", () => hop(q), o.resume) : attach(c, o));
      if (server.upgrade(req, { data: { ready } })) return;
      return new Response("no", { status: 400 });
    },
    websocket,
  });
}

// one tab on the socket: what it saw so far, and a wait for a pattern of it
async function tab(url: string) {
  const c = await dial(url);
  let seen = "";
  const waits: (() => void)[] = [];
  c.onMessage((d, bin) => {
    if (!bin) return;
    seen += dec.decode(d as Uint8Array);
    for (const w of waits.splice(0)) w();
  });
  const closed = new Promise<number>((r) => c.onClose(() => r(c.code)));
  const until = (re: RegExp, ms = 5000) =>
    new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no ${re} in ${JSON.stringify(seen)}`)), ms);
      const check = () => {
        if (!re.test(seen)) return waits.push(check);
        clearTimeout(t);
        res(seen);
      };
      check();
    });
  const type = (s: string) => c.binary(enc.encode(s));
  const json = (v: unknown) => c.json(v);
  const bytes = () => enc.encode(seen).length;
  return { c, until, type, json, seen: () => seen, bytes, closed };
}

const fake = await fakeSSHD();
const front = serveTerm(fake);
const wsURL = (sid: string, extra: Record<string, string> = {}, port = front.port) =>
  `ws://127.0.0.1:${port}/api/term/box?${new URLSearchParams({ sid, since: "0", ...extra })}`;
let n = 0;
const newSID = () => `sid${String(++n).padStart(3, "0")}xyz`;

afterAll(() => {
  front.stop(true);
  fake.stop();
});

test("login prompts, the shell, shared screens, typing, close", async () => {
  const sid = newSID();
  const t = await tab(wsURL(sid));
  t.json({ type: "resize", cols: 100, rows: 30 });
  t.json({ type: "share", on: true, by: "alice" });
  await t.until(/box login: $/);
  t.type("ux");
  t.type("\x7f\r");
  await t.until(/password: $/);
  expect(t.seen()).toBe("box login: ux\b \b\r\npassword: ");
  t.type("pw\r");
  await t.until(/\$ $/);
  expect(t.seen().slice(t.seen().indexOf("password: "))).toBe(`password: \r\n${clear}shell xterm-256color 100x30\r\n$ `);
  expect(sessionCount()).toBe(1);

  // the snapshot phosphorus reads, and a resize reaching the far pty
  let sc = await screens("alice");
  expect(sc).toEqual([{ id: sid.slice(0, 6), cols: 100, rows: 30, screen: "shell xterm-256color 100x30\n$" }]);
  expect(await screens("bob")).toEqual([]);
  expect((await screens("")).length).toBe(1);
  t.json({ type: "resize", cols: 120, rows: 40 });
  // cols and rows outside 1..1000 or not whole: kept as they were
  t.json({ type: "resize", cols: 0, rows: 40.5 });
  await Bun.sleep(100);
  expect(fake.winch).toEqual([{ cols: 120, rows: 40 }, { cols: 120, rows: 40 }]);

  // a command run at once, its output settled
  let r = await typeIn("alice", sid.slice(0, 4), "echo hi", 5, true);
  expect(r.ran).toBe(true);
  expect(r.id).toBe(sid.slice(0, 6));
  expect(r.screen.split("\n")).toEqual(["shell xterm-256color 100x30", "$ echo hi", "hi", "$"]);
  expect(r.note).toBeUndefined();
  await t.until(/hi\r\n\$ $/);

  // one typed and left: the owner's Enter runs it, their ^C cancels it
  const p = typeIn("alice", sid, "echo hi", 5, false);
  await t.until(/\$ echo hi$/);
  await expect(typeIn("alice", sid, "ls", 1, false)).rejects.toThrow("already waiting");
  t.type("\r");
  r = await p;
  expect(r.ran).toBe(true);
  r = await typeIn("alice", sid, "echo\x01 hi\x1b[A", 1, false);
  expect(r.ran).toBe(false);
  expect(r.why).toBe("no Enter in 1s, still typed there");
  // control bytes dropped from what's typed, as the escape of an arrow key is
  expect(r.screen.endsWith("$ echo hi[A")).toBe(true);
  const q = typeIn("alice", sid, "x", 5, false);
  await t.until(/\[Ax$/);
  t.type("\x03");
  expect((await q).why).toBe("they cancelled it");

  // nothing to type; a credential asked for on the screen, nothing typed
  await expect(typeIn("alice", sid, " \x00 ", 1, true)).rejects.toThrow("nothing to type");
  t.type("\rask\r");
  await t.until(/password for u: $/);
  await expect(typeIn("alice", sid, "pw", 1, true)).rejects.toThrow("asking for a credential");
  await expect(typeIn("bob", sid, "x", 1, true)).rejects.toThrow("no terminal of theirs");
  expect(() => close("bob", sid)).toThrow("no shared terminal");
  expect(() => close("alice", "")).toThrow("no shared terminal");

  close("alice", sid.slice(0, 3));
  expect(await t.closed).toBe(Ended);
  expect(sessionCount()).toBe(0);
  expect(await screens("")).toEqual([]);
}, 20_000);

test("a wrong password, then a close from the tab", async () => {
  const sid = newSID();
  const t = await tab(wsURL(sid));
  await t.until(/login: $/);
  t.type("   \r");
  await t.until(/login: {4}\r\nbox login: $/);
  t.type("u\r");
  await t.until(/password: $/);
  t.type("bad\r");
  await t.until(/access denied\r\n\r\nbox login: $/);
  expect(t.seen().includes("bad")).toBe(false);
  t.json({ type: "close" });
  expect(await t.closed).toBe(Ended);
  expect(sessionCount()).toBe(0);
}, 20_000);

test("a rejoin replays what's missing and takes the session; a dropped tab gets a grace", async () => {
  const sid = newSID();
  const t = await tab(wsURL(sid, { shell: 'exec "$SHELL" -l' }));
  await t.until(/login: $/);
  t.type("u\r");
  await t.until(/password: $/);
  t.type("pw\r");
  await t.until(/\$ $/);
  expect(fake.execs).toEqual(['exec "$SHELL" -l']);
  const got = t.bytes();
  const t2 = await tab(wsURL(sid, { since: String(got), resume: "1" }));
  expect(await t.closed).toBe(Taken);
  t2.type("echo hi\r");
  await t2.until(/hi\r\n\$ $/);
  expect(t2.seen()).toBe("echo hi\r\nhi\r\n$ ");
  expect(sessionCount()).toBe(1);
  // the socket gone, the shell kept for a rejoin from the start
  t2.c.terminate();
  await Bun.sleep(50);
  expect(sessionCount()).toBe(1);
  const t3 = await tab(wsURL(sid, { resume: "1" }));
  await t3.until(/hi\r\n\$ $/);
  expect(t3.seen()).toBe(t.seen() + t2.seen());
  // the shell exiting ends it for good; a resume after is told so
  t3.type("exit\r");
  expect(await t3.closed).toBe(Ended);
  expect(sessionCount()).toBe(0);
  const t4 = await tab(wsURL(sid, { resume: "1" }));
  expect(await t4.closed).toBe(Ended);
  expect(t4.seen()).toBe("\r\n\x1b[2m[session ended]\x1b[0m\r\n");
}, 20_000);

test("a saved login signs in unseen and runs its command", async () => {
  const sid = newSID();
  const t = await tab(wsURL(sid, { auto: "1" }));
  t.json({ type: "share", on: true, by: "alice" });
  t.json({ type: "login", user: "u", pass: "pw", run: "echo hi" });
  await t.until(/hi\r\n\$ $/);
  expect(t.seen()).toBe(`${clear}shell xterm-256color 80x24\r\n$ echo hi\r\nhi\r\n$ `);
  // the shared sessions, by id prefix: ambiguity refused
  const sid2 = newSID();
  const t2 = await tab(wsURL(sid2, { auto: "1" }));
  t2.json({ type: "share", on: true, by: "alice" });
  t2.json({ type: "login", user: "u", pass: "pw" });
  await t2.until(/\$ $/);
  expect((await screens("alice")).map((s) => s.id).sort()).toEqual([sid, sid2].map((s) => s.slice(0, 6)).sort());
  await expect(typeIn("alice", "sid", "x", 1, true)).rejects.toThrow("several shared terminals");
  expect(() => close("alice", "sid")).toThrow("several match");
  // output still coming when the wait runs out, noted
  const r = await typeIn("alice", sid2, "slow", 1, true);
  expect(r.note).toBe("still printing, terminal_screen with wait_s reads more");
  t.json({ type: "close" });
  t2.json({ type: "close" });
  await Promise.all([t.closed, t2.closed]);
}, 20_000);

test("a saved login refused is asked for by hand; one typed in at the prompt", async () => {
  const sid = newSID();
  const t = await tab(wsURL(sid, { auto: "1" }));
  t.json({ type: "login", user: "u", pass: "nope", run: "echo hi" });
  await t.until(/access denied\r\n\r\nbox login: $/);
  // a login message answering the drawn prompt: the user shown, the password not
  t.json({ type: "login", user: "u", pass: "pw", run: "echo hi" });
  await t.until(/hi\r\n\$ $/);
  expect(t.seen()).toBe(`access denied\r\n\r\nbox login: u\r\npassword: \r\n${clear}shell xterm-256color 80x24\r\n$ echo hi\r\nhi\r\n$ `);
  t.json({ type: "close" });
  await t.closed;
}, 20_000);

test("a hop to the owning peer", async () => {
  const peer = serveTerm(fake);
  const hub = serveTerm(fake, (q) => (q.get("sid")?.startsWith("sid") ? wsURL(q.get("sid")!, { hop: "1", ...(q.has("resume") ? { resume: "1" } : {}) }, peer.port) : ""));
  const sid = newSID();
  const t = await tab(wsURL(sid, {}, hub.port));
  t.json({ type: "resize", cols: 50, rows: 10 });
  await t.until(/login: $/);
  t.type("u\r");
  await t.until(/password: $/);
  t.type("pw\r");
  await t.until(/shell xterm-256color 50x10\r\n\$ $/);
  // the peer's session is the one shared, its ends relayed
  const t2 = await tab(wsURL(sid, { resume: "1" }, hub.port));
  expect(await t.closed).toBe(Taken);
  t2.json({ type: "close" });
  expect(await t2.closed).toBe(Ended);
  const gone = await tab(wsURL("nope", {}, hub.port));
  expect(await gone.closed).toBe(Ended);
  expect(gone.seen()).toBe("can't find box on the tailnet\r\n");
  const gone2 = await tab(wsURL("nope", { resume: "1" }, hub.port));
  expect(await gone2.closed).toBe(1000);
  peer.stop(true);
  const dead = await tab(wsURL(newSID(), {}, hub.port));
  expect(await dead.closed).toBe(Ended);
  expect(dead.seen().startsWith("box didn't answer: ")).toBe(true);
  hub.stop(true);
}, 20_000);
