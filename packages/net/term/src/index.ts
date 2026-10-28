// an ssh session per browser tab into the host sshd, or a hop to the owning
// peer, binary frames for bytes, text for JSON resize and close

import { errText, obj, sleep } from "@phosphorus/util";
import { type Conn, dial } from "@phosphorus/wsock";
import { Client, type ClientChannel } from "ssh2";
import { render } from "./render.ts";

export { render, screenLines } from "./render.ts";

const loginTimeout = 120_000;
const maxTries = 3;
const maxField = 256;
const grace = 10 * 60_000;
const replayMax = 256 * 1024;
// Ended close code for a session gone for good
export const Ended = 4000;
// Taken close code for a socket another tab took the session from
export const Taken = 4001;
const hopTimeout = 10_000;
const settle = 1500;
const maxCommand = 2000;
// autoWait how long a tab promising a saved login is given to send it
const autoWait = 5000;

const control = /[\x00-\x1f\x7f-\x9f]/g;
const secretPrompt = /pass(word|phrase)|token|secret|\bpin\b|\[sudo\]/i;
// the login prompts wiped once in, the shell starting on a clean screen
const clearScreen = "\x1b[H\x1b[2J\x1b[3J";
const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const runes = (s: string, n: number) => (s.length > n ? [...s].slice(0, n).join("") : s);

const dim = (n: unknown, fallback: number) =>
  typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 1000 ? n : fallback;

type Login = { user: string; pass: string; run: string };

const sessions = new Map<string, Session>();
const live = (sid: string) => sessions.has(sid);

function send(ws: Conn | undefined, b: Uint8Array) {
  if (ws?.open()) ws.binary(b);
}

class Session {
  ws?: Conn;
  client?: Client;
  chan?: ClientChannel;
  onInput?: (b: Uint8Array) => void;
  shared = false;
  owner = "";
  cols = 80;
  rows = 24;
  seq = 0;
  base = 0;
  chunks: Uint8Array[] = [];
  graceTimer?: ReturnType<typeof setTimeout>;
  loginTimer?: ReturnType<typeof setTimeout>;
  lastOut = 0;
  waiter?: (key: string) => void;
  streaming = false;
  // a saved login handed over by the page, taken by the prompts in place of typing
  auto?: Login;
  autoWaiter?: (l: Login) => void;
  // the prompt waiting on a line, let go when the session ends
  asker?: () => void;

  constructor(public sid: string) {}

  out(b: Uint8Array) {
    if (!b.length) return;
    b = new Uint8Array(b);
    this.chunks.push(b);
    this.seq += b.length;
    this.lastOut = Date.now();
    let kept = this.seq - this.base;
    while (this.chunks.length && kept - this.chunks[0]!.length >= replayMax) {
      kept -= this.chunks[0]!.length;
      this.base += this.chunks[0]!.length;
      this.chunks.shift();
    }
    send(this.ws, b);
  }

  // keystrokes into the shell, none once its channel has gone
  write(b: string | Uint8Array) {
    if (this.chan?.writable) this.chan.write(b);
  }

  end() {
    if (sessions.get(this.sid) !== this) return;
    sessions.delete(this.sid);
    clearTimeout(this.graceTimer);
    clearTimeout(this.loginTimer);
    this.asker?.();
    this.waiter?.("closed");
    this.client?.destroy();
    this.ws?.close(Ended);
  }

  // the page's saved login, held for the first prompt to take
  offer(l: Login) {
    const w = this.autoWaiter;
    if (w) {
      this.autoWaiter = undefined;
      w(l);
    } else this.auto ??= l;
  }

  take(ms: number): Promise<Login | undefined> {
    return new Promise((resolve) => {
      if (this.auto) {
        const a = this.auto;
        this.auto = undefined;
        return resolve(a);
      }
      const t = setTimeout(() => {
        this.autoWaiter = undefined;
        resolve(undefined);
      }, ms);
      this.autoWaiter = (l) => {
        clearTimeout(t);
        resolve(l);
      };
    });
  }

  join(ws: Conn, since: number) {
    clearTimeout(this.graceTimer);
    if (this.ws && this.ws !== ws) this.ws.close(Taken);
    this.ws = ws;
    let at = this.base;
    for (const c of this.chunks) {
      const skip = Math.max(0, since - at);
      if (skip < c.length) send(ws, c.subarray(skip));
      at += c.length;
    }
    ws.onMessage((data, binary) => {
      if (this.ws !== ws) return;
      if (binary) {
        const b = data as Uint8Array;
        if (this.waiter && b.includes(0x0d)) this.waiter("enter");
        else if (this.waiter && b.includes(0x03)) this.waiter("cancel");
        this.onInput?.(b);
        return;
      }
      let m: Record<string, any> | undefined;
      try {
        m = obj(JSON.parse(data as string));
      } catch {}
      if (!m) return;
      switch (m.type) {
        case "close":
          this.end();
          return;
        case "login": {
          const user = typeof m.user === "string" ? m.user : "";
          const pass = typeof m.pass === "string" ? m.pass : "";
          const run = typeof m.run === "string" ? m.run : "";
          if (user && Buffer.byteLength(user) <= maxField && Buffer.byteLength(pass) <= maxField)
            this.offer({ user, pass, run });
          return;
        }
        case "share":
          this.shared = m.on === true;
          if (typeof m.by === "string") this.owner = runes(m.by, maxField);
          return;
        case "resize":
          this.cols = dim(m.cols, this.cols);
          this.rows = dim(m.rows, this.rows);
          this.chan?.setWindow(this.rows, this.cols, 0, 0);
          return;
      }
    });
    ws.onClose(() => {
      if (this.ws !== ws || !live(this.sid)) return;
      this.ws = undefined;
      if (this.streaming) this.graceTimer = setTimeout(() => this.end(), grace);
      else this.end();
    });
  }

  render() {
    return render(this.chunks, this.cols, this.rows);
  }
}

// Opts a tab's join
export type Opts = {
  host: string;
  sid: string;
  since: number;
  resume: boolean;
  sshHost: string;
  port: number;
  shell: string;
  // auto a saved login follows on the socket: its prompts never drawn
  auto: boolean;
};

// attach login and password prompts, then the host's own shell, or a rejoin
export function attach(ws: Conn, o: Opts) {
  const l = sessions.get(o.sid);
  if (l) return l.join(ws, o.since);
  if (o.resume) {
    send(ws, bytes("\r\n\x1b[2m[session ended]\x1b[0m\r\n"));
    ws.close(Ended);
    return;
  }
  const s = new Session(o.sid);
  sessions.set(o.sid, s);
  s.join(ws, 0);
  s.loginTimer = setTimeout(() => {
    if (!s.streaming) s.end();
  }, loginTimeout);

  // a saved login's password and command, once its user has answered the first prompt
  let held: Login | undefined;
  // one line typed at a prompt, or the saved login's answer; undefined once the session's gone
  const ask = (label: string, echo: boolean) =>
    new Promise<string | undefined>((resolve) => {
      if (!live(o.sid)) return resolve(undefined);
      s.out(bytes(label));
      if (!echo && held) {
        s.out(bytes("\r\n"));
        return resolve(held.pass);
      }
      const line: string[] = [];
      const dec = new TextDecoder();
      const done = (v?: string) => {
        s.onInput = s.autoWaiter = s.asker = undefined;
        resolve(v);
      };
      s.asker = done;
      s.onInput = (buf) => {
        for (const ch of dec.decode(buf, { stream: true })) {
          if (ch === "\r" || ch === "\n") {
            s.out(bytes("\r\n"));
            return done(line.join(""));
          }
          if (ch === "\x7f" || ch === "\b") {
            if (!line.length) continue;
            line.pop();
            if (echo) s.out(bytes("\b \b"));
          } else if (ch >= " " && line.length < maxField) {
            line.push(ch);
            if (echo) s.out(bytes(ch));
          }
        }
      };
      const taken = (a: Login) => {
        if (!echo) {
          s.out(bytes("\r\n"));
          return done(a.pass);
        }
        held = a;
        s.out(bytes(a.user + "\r\n"));
        done(a.user);
      };
      if (s.auto) {
        const a = s.auto;
        s.auto = undefined;
        taken(a);
      } else s.autoWaiter = taken;
    });

  (async () => {
    // a promised saved login signs in unseen, the screen blank until the shell
    if (o.auto) held = await s.take(autoWait);
    for (let i = 0; i < maxTries; i++) {
      let user: string, pass: string;
      if (held && i === 0 && o.auto) ({ user, pass } = held);
      else {
        const u = await ask(`${o.host} login: `, true);
        if (u === undefined || !live(o.sid)) return;
        user = u.trim();
        if (!user) {
          i--;
          continue;
        }
        const p = await ask("password: ", false);
        if (p === undefined) return;
        pass = p;
      }
      const why = await connect(s, o, user, pass);
      if (!why && held?.run) s.write(held.run + "\r");
      // a refused saved login asked for by hand after
      held = undefined;
      if (!why || !live(o.sid)) return;
      s.client = undefined;
      s.out(bytes(why + "\r\n\r\n"));
    }
    s.end();
  })();
}

// connect "" once the shell is up, else why not
function connect(s: Session, o: Opts, user: string, pass: string): Promise<string> {
  const c = new Client();
  return new Promise<string>((resolve) => {
    c.on("ready", () => resolve(""));
    // after ready a lost connection ends the session by its close, never thrown
    c.on("error", (e) => resolve(/authentication methods failed/i.test(e.message) ? "access denied" : e.message));
    c.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pass)));
    c.connect({
      host: o.sshHost,
      port: o.port,
      username: user,
      password: pass,
      tryKeyboard: true,
      readyTimeout: 10_000,
    });
  }).then(async (why) => {
    if (why) {
      c.destroy();
      return why;
    }
    s.client = c;
    const pty = { term: "xterm-256color", rows: s.rows, cols: s.cols };
    const r = await new Promise<ClientChannel | Error>((res) => {
      const cb = (e: Error | undefined, ch: ClientChannel) => res(e ?? ch);
      if (o.shell) c.exec(o.shell, { pty }, cb);
      else c.shell(pty, cb);
    });
    if (r instanceof Error) {
      c.destroy();
      return r.message;
    }
    s.chan = r;
    s.streaming = true;
    s.onInput = (b) => s.write(b);
    s.out(bytes(clearScreen));
    r.on("data", (d: Uint8Array) => s.out(d));
    r.stderr.on("data", (d: Uint8Array) => s.out(d));
    r.on("error", () => {});
    r.on("close", () => s.end());
    c.on("close", () => s.end());
    return "";
  });
}

const relay = (to: Conn, b: string | Uint8Array, bin: boolean) =>
  bin ? to.binary(b as Uint8Array) : to.text(b as string);

// forward the browser's socket spliced onto the owning peer's
export function forward(ws: Conn, host: string, lookup: () => string | Promise<string>, resume: boolean) {
  let up: Conn | undefined;
  let early: [string | Uint8Array, boolean][] = [];
  const fail = (why: string) => {
    send(ws, bytes(why + "\r\n"));
    ws.close(resume ? 1000 : Ended);
  };
  ws.onMessage((b, bin) => {
    if (up?.open()) relay(up, b, bin);
    else early.push([b, bin]);
  });
  ws.onClose(() => up?.terminate());
  (async () => {
    const url = await lookup();
    if (!ws.open()) return;
    if (!url) return fail(`can't find ${host} on the tailnet`);
    let u: Conn;
    try {
      u = await dial(url, {}, hopTimeout);
    } catch (e) {
      return fail(`${host} didn't answer: ${errText(e)}`);
    }
    up = u;
    for (const [b, bin] of early) relay(u, b, bin);
    early = [];
    if (!ws.open()) return u.terminate();
    u.onMessage((b, bin) => relay(ws, b, bin));
    u.onClose(() => ws.close(u.code === Ended || u.code === Taken ? u.code : 1000));
  })();
}

// sessionCount sessions alive here
export const sessionCount = () => sessions.size;

// Screen one shared terminal as phosphorus sees it
export type Screen = { id: string; cols: number; rows: number; screen: string };

const shared = (by: string) => [...sessions.values()].filter((s) => s.shared && s.streaming && (!by || s.owner === by));

// screens every logged-in session its owner shared, by: one person's only
export async function screens(by: string): Promise<Screen[]> {
  const out: Screen[] = [];
  for (const s of shared(by)) out.push({ id: s.sid.slice(0, 6), cols: s.cols, rows: s.rows, screen: await s.render() });
  return out;
}

// close one of the owner's shared sessions, ended for every tab on it
export function close(by: string, id: string) {
  const mine = shared("").filter((s) => by && s.owner === by && id && s.sid.startsWith(id));
  if (!mine.length) throw new Error("no shared terminal of theirs with that id here");
  if (mine.length > 1) throw new Error("several match, give more of the id");
  mine[0]!.end();
}

// typeIn a command typed into the owner's shared screen, left for them to run,
// or with run entered at once as theirs, their key's own ask
export async function typeIn(
  by: string,
  id: string,
  text: string,
  waitS: number,
  run: boolean,
): Promise<Record<string, any>> {
  const mine = shared("").filter((s) => by && s.owner === by && s.sid.startsWith(id));
  if (mine.length !== 1) {
    throw new Error(
      mine.length
        ? "several shared terminals, give its id"
        : "no terminal of theirs is shared with phosphorus and logged in here",
    );
  }
  const s = mine[0]!;
  if (s.waiter) throw new Error("already waiting on a command there");
  const before = await s.render();
  const ls = before.split("\n");
  if (secretPrompt.test(ls[ls.length - 1]!))
    throw new Error("the terminal is asking for a credential, they type that themselves");
  const cmd = runes(text.replace(control, ""), maxCommand);
  if (!cmd.trim()) throw new Error("nothing to type");
  const until = Date.now() + waitS * 1000;
  if (run) {
    s.lastOut = Date.now();
    s.write(cmd + "\r");
    return settled(s, Date.now(), until);
  }
  s.write(cmd);
  const key = await new Promise<string>((resolve) => {
    const t = setTimeout(() => {
      s.waiter = undefined;
      resolve("timeout");
    }, waitS * 1000);
    s.waiter = (k) => {
      s.waiter = undefined;
      clearTimeout(t);
      resolve(k);
    };
  });
  if (key !== "enter") {
    const why: Record<string, string> = {
      cancel: "they cancelled it",
      closed: "the terminal closed",
      timeout: `no Enter in ${waitS}s, still typed there`,
    };
    return { id: s.sid.slice(0, 6), ran: false, why: why[key], screen: await s.render() };
  }
  return settled(s, Date.now(), until);
}

// settled the screen once output stops for a moment after entered, or at until
async function settled(s: Session, entered: number, until: number): Promise<Record<string, any>> {
  const quiet = () => Date.now() - Math.max(s.lastOut, entered);
  while (Date.now() < until && quiet() < settle && live(s.sid)) await sleep(250);
  const out: Record<string, any> = { id: s.sid.slice(0, 6), ran: true, screen: await s.render() };
  if (quiet() < settle) out.note = "still printing, terminal_screen with wait_s reads more";
  return out;
}
