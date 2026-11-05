// one app's main process and the viewer who has it: the hook's frames passed to the page as
// they come, the page's to the hook, the server keeping only what serves the app's documents
// and resources (its windows, its schemes) and answering those requests itself

import { createHmac, randomBytes } from "node:crypto";
import { codec, fromPage, headOf, Op, Reader, wire } from "./frames.ts";
import type { Pipe, Proc } from "./pipe.ts";

export type Viewer = {
  binary(b: Uint8Array): void;
  json(v: unknown): void;
  queued(): number;
  close(code?: number): void;
};

export type ViewerInfo = { w: number; h: number; dpr: number; dark: boolean };

export type Ready = {
  name: string;
  version: string;
  electron: string;
  platform: string;
  arch: string;
  execPath: string;
  pid: number;
  env: Record<string, string>;
  versions: Record<string, string>;
  schemes: string[];
  sep: string;
};

export type Prefs = {
  preloads: { path: string; text: string }[];
  args: string[];
  sandbox: boolean;
  isolation: boolean;
  node: boolean;
  zoom: number;
};

type Fetching = {
  head: (status: number, headers: Record<string, string>) => void;
  body: (b: Uint8Array) => void;
  end: (err?: string) => void;
};

export type Res = { status: number; headers: Record<string, string>; body: ReadableStream<Uint8Array> };

const sessions = new Map<string, AppWeb>();
const byKey = new Map<string, AppWeb>();
let secret = randomBytes(32);
// the resource keys' secret, kept by the server so the browser's cache outlives a restart
export const setSecret = (b: Uint8Array) => {
  secret = Buffer.from(b);
};
// unwatched this long, an app is closed: a reload or a dropped link comes back well within
export const lingerMs = 30 * 60_000;

export class AppWeb {
  readonly id = randomBytes(12).toString("hex");
  // the sync key: the page's sendSync, this session only
  readonly skey = randomBytes(16).toString("hex");
  // the resource key: the same for this viewer, host and app version across sessions, so the
  // browser's cache of the app's files outlives one run
  rkey = "";
  info?: Ready;
  readonly windows = new Map<number, { url: string; prefs?: Prefs }>();
  readonly created = Date.now();
  lastSeen = Date.now();
  title = "";
  private viewer?: Viewer;
  private vinfo: ViewerInfo = { w: 1920, h: 1080, dpr: 1, dark: false };
  private fetches = new Map<number, Fetching>();
  private fetchSeq = 0x40000000;
  private syncs = new Map<string, (b: Uint8Array) => void>();
  private ready?: Promise<void>;
  private readyOk?: () => void;
  private ended = false;
  private fromViewerReader: Reader;
  onEnd?: (why: string) => void;

  constructor(
    readonly owner: string,
    readonly exe: string,
    private link: Pipe,
    private token: string,
    readonly proc?: Proc,
  ) {
    this.ready = new Promise((ok) => {
      this.readyOk = ok;
    });
    const r = new Reader((f, w) => this.fromApp(f, w));
    let out: Uint8Array[] = [];
    let at = 0;
    this.out = (w: Uint8Array) => {
      out.push(w);
      at += w.length;
    };
    this.flush = () => {
      if (!at) return;
      const b = out.length === 1 ? out[0]! : Buffer.concat(out);
      out = [];
      at = 0;
      this.viewer?.binary(b);
    };
    link.onData((b) => {
      try {
        r.push(b);
      } catch (e) {
        this.end(`the app's link broke: ${e}`);
        return;
      }
      this.flush();
    });
    link.onClose(() => this.end("the app quit"));
    proc?.onClose(() => this.end("the app quit"));
    this.fromViewerReader = new Reader((f, w) => {
      const h = headOf(f);
      if (fromPage.has(h.op)) this.link.write(w);
    });
    sessions.set(this.id, this);
    this.hello();
  }

  private out: (w: Uint8Array) => void;
  private flush: () => void;

  private hello() {
    this.link.write(wire(codec.frame(Op.hello, 0, 0, { token: this.token, viewer: this.vinfo })));
  }

  private fromApp(f: Uint8Array, w: Uint8Array) {
    const h = headOf(f);
    switch (h.op) {
      case Op.resHead: {
        const x = this.fetches.get(h.id);
        if (x) {
          const [status, headers] = codec.body(f);
          x.head(status, headers ?? {});
        }
        return;
      }
      case Op.resBody:
        this.fetches.get(h.id)?.body(f.slice(codec.Head));
        return;
      case Op.resEnd: {
        const x = this.fetches.get(h.id);
        this.fetches.delete(h.id);
        x?.end(codec.body(f)?.error);
        return;
      }
      case Op.reply: {
        const k = `${h.wc}:${h.id}`;
        const s = this.syncs.get(k);
        if (s) {
          this.syncs.delete(k);
          return s(f.slice());
        }
        break;
      }
      case Op.ready: {
        const i = codec.body(f) as Ready & { windows: { id: number; url: string; prefs?: Prefs }[] };
        this.info = i;
        for (const x of i.windows ?? []) this.windows.set(x.id, { url: x.url, prefs: x.prefs });
        this.rkey = createHmac("sha256", secret)
          .update(`${this.owner}\0${this.exe}\0${i.version}\0${i.electron}`)
          .digest("hex")
          .slice(0, 32);
        byKey.set(this.rkey, this);
        this.readyOk?.();
        break;
      }
      case Op.win: {
        const s = codec.body(f);
        this.windows.set(h.wc, { url: s.url, prefs: s.prefs });
        if (!this.title && s.title) this.title = s.title;
        break;
      }
      case Op.load: {
        const [url, prefs] = codec.body(f);
        this.windows.set(h.wc, { url, prefs });
        break;
      }
      case Op.call: {
        const [m, a] = codec.body(f);
        if (m === "title" && typeof a?.[0] === "string") this.title = a[0];
        break;
      }
      case Op.gone:
        this.windows.delete(h.wc);
        break;
    }
    if (this.viewer) this.out(w);
  }

  // a viewer takes over: told the base its windows load from, the app's state sent fresh
  async attach(v: Viewer, vi: ViewerInfo, base: string) {
    if (this.viewer && this.viewer !== v) {
      this.viewer.json({ t: "taken" });
      this.viewer.close(4000);
    }
    this.viewer = v;
    this.vinfo = vi;
    this.lastSeen = Date.now();
    await this.ready;
    if (this.viewer !== v) return;
    v.json({ t: "ready", id: this.id, base: `${base}/r/${this.rkey}/`, sync: `${base}/x/${this.skey}/sync` });
    // the app's READY answers this, with every window it has
    this.hello();
  }

  detach(v: Viewer) {
    if (this.viewer !== v) return;
    this.viewer = undefined;
    this.lastSeen = Date.now();
  }

  get watched() {
    return !!this.viewer;
  }

  get alive() {
    return !this.ended;
  }

  // what the page sent: frames, one or more per message
  fromViewer(b: Uint8Array) {
    this.lastSeen = Date.now();
    this.fromViewerReader.push(b);
  }

  // one of the app's URLs as its own renderer would have it
  async fetch(wc: number, url: string, headers: Record<string, string> = {}): Promise<Res> {
    await this.ready;
    if (this.ended) throw new Error("the app has quit");
    const id = this.fetchSeq++;
    if (this.fetchSeq > 0x7fffffff) this.fetchSeq = 0x40000000;
    return new Promise((ok, no) => {
      let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
        },
      });
      const t = setTimeout(() => {
        this.fetches.delete(id);
        no(new Error("the app took too long to answer"));
      }, 30_000);
      this.fetches.set(id, {
        head: (status, h) => {
          clearTimeout(t);
          ok({ status, headers: h, body });
        },
        body: (b) => ctl?.enqueue(b),
        end: (err) => {
          clearTimeout(t);
          try {
            ctl?.close();
          } catch {}
          no(new Error(err || "no answer"));
        },
      });
      this.link.write(wire(codec.frame(Op.fetch, wc, id, [url, "GET", headers])));
    });
  }

  // a page's ipcRenderer.sendSync, its frame as the page made it, answered with the app's reply frame
  sync(frame: Uint8Array): Promise<Uint8Array> {
    const h = headOf(frame);
    if (h.op !== Op.sync) return Promise.reject(new Error("not a sync frame"));
    return new Promise((ok, no) => {
      const k = `${h.wc}:${h.id}`;
      const t = setTimeout(() => {
        this.syncs.delete(k);
        no(new Error("the app took too long to answer"));
      }, 30_000);
      this.syncs.set(k, (b) => {
        clearTimeout(t);
        ok(b);
      });
      this.link.write(wire(frame));
    });
  }

  end(why = "closed") {
    if (this.ended) return;
    this.ended = true;
    for (const f of this.fetches.values()) f.end("the app quit");
    this.fetches.clear();
    sessions.delete(this.id);
    if (byKey.get(this.rkey) === this) {
      byKey.delete(this.rkey);
      for (const s of sessions.values()) if (s.rkey === this.rkey) byKey.set(this.rkey, s);
    }
    try {
      this.link.close();
    } catch {}
    try {
      this.proc?.close();
    } catch {}
    this.viewer?.json({ t: "ended", why });
    this.viewer?.close(1000);
    this.viewer = undefined;
    this.onEnd?.(why);
  }
}

export const byResourceKey = (k: string) => byKey.get(k);
export const bySyncKey = (k: string) => [...sessions.values()].find((s) => s.skey === k);
export const find = (owner: string, id: string) => {
  const s = sessions.get(id);
  return s && s.owner === owner ? s : undefined;
};
export const list = (owner: string) => [...sessions.values()].filter((s) => s.owner === owner);
export const count = () => sessions.size;
// whether any app still uses this owner's connection, to keep it open
export const busy = (owner: string) => list(owner).length > 0;
// every app unwatched past the linger ended; from the server's tick
export function reap(now = Date.now()) {
  for (const s of [...sessions.values()]) if (!s.watched && now - s.lastSeen > lingerMs) s.end("unwatched");
}
