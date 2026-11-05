// what the page asks of a host's desktop, each through its session's probe or sftp,
// anywhere the login itself may reach

import { randomInt } from "node:crypto";
import type { SFTPWrapper } from "ssh2";
import { cacheGet, cachePut } from "./cache.ts";
import { type App, appItem, buildDesk, parseApps, parseEntry, trashInfo } from "./linux.ts";
import type { Desk, Entry, Item, Root } from "./model.ts";
import { baseName, sftpPath } from "./paths.ts";
import { records } from "./proto.ts";
import { binName, writeInfo } from "./recycle.ts";
import type { Session } from "./session.ts";
import { winDesk, winItem } from "./windows.ts";

// Ctx what a session keeps between calls
type Ctx = {
  icons: Set<string>;
  desk?: Desk;
  apps?: Item[];
  // the host runs phosphorus: a terminal there opens powershell
  psTerm: boolean;
  // icons on their way, by cache key
  pending: Map<string, Promise<Blob | undefined>>;
};

const win = (s: Session) => s.os === "windows";

export function ctxOf(s: Session, psTerm = false): Ctx {
  s.extra.ctx ??= { icons: new Set<string>(), psTerm, pending: new Map() } satisfies Ctx;
  return s.extra.ctx as Ctx;
}

const json = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    throw new Error("the probe answered something that isn't json");
  }
};

function issue(c: Ctx, items: Item[]) {
  for (const it of items) {
    if (it.icon) c.icons.add(it.icon);
  }
}

// the desktop as drawn: wallpaper, theme, icons, pins
export async function desktop(s: Session): Promise<Desk> {
  const c = ctxOf(s);
  let d: Desk;
  if (win(s)) {
    const o = json(await s.call("desktop"));
    d = winDesk(o, c.psTerm);
  } else {
    const [dt, ap] = await Promise.all([s.call("desktop"), s.call("apps", "", 120_000)]);
    const recs = records(dt);
    const de = /\nde=(\w+)/.exec(`\n${recs.find((r) => r.kind === "env")?.body ?? ""}`)?.[1] ?? "plain";
    const apps = parseApps(records(ap), de, buildDesk(recs, []).icontheme ?? "hicolor");
    d = buildDesk(recs, apps);
    c.apps = apps.map(({ entry: _e, ...it }: App) => it);
    issue(c, c.apps);
  }
  c.desk = d;
  issue(c, [...d.icons, ...d.pins]);
  return d;
}

// every app the start menu lists
export async function apps(s: Session): Promise<Item[]> {
  const c = ctxOf(s);
  if (!c.desk) await desktop(s);
  if (!win(s)) return c.apps ?? [];
  const list = (json(await s.call("apps", "", 120_000)) as any[]).map((x) =>
    winItem(x, c.psTerm || c.desk?.sshShell === "powershell"),
  );
  c.apps = list.sort((a, b) => a.name.localeCompare(b.name));
  issue(c, c.apps);
  return c.apps;
}

export type Blob = { type: string; bytes: Uint8Array };

const typeOf = (p: string) =>
  /\.svg$/i.test(p)
    ? "image/svg+xml"
    : /\.png$/i.test(p)
      ? "image/png"
      : /\.jpe?g$/i.test(p)
        ? "image/jpeg"
        : /\.webp$/i.test(p)
          ? "image/webp"
          : /\.gif$/i.test(p)
            ? "image/gif"
            : /\.bmp$/i.test(p)
              ? "image/bmp"
              : /\.avif$/i.test(p)
                ? "image/avif"
                : "application/octet-stream";

// sniffed when the name says nothing, as TranscodedWallpaper
function sniff(b: Uint8Array, p: string): string {
  const t = typeOf(p);
  if (t !== "application/octet-stream") return t;
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  return t;
}

const iconMax = 1 << 20;
const wallMax = 48 << 20;

const iconKey = (spec: string, v: string) => `icon\0${spec}\0${v}`;

// an icon the probe issued, from the cache when its version matches
export async function icon(s: Session, host: string, spec: string, v: string): Promise<Blob | undefined> {
  const c = ctxOf(s);
  if (!c.icons.has(spec)) return;
  const key = iconKey(spec, v);
  const hit = cacheGet(host, key);
  if (hit) return unpack(hit);
  const p = c.pending.get(key) ?? track(c, key, host, fetchIcon(s, spec));
  return p;
}

function track(c: Ctx, key: string, host: string, p: Promise<Blob | undefined>) {
  const q = p.then((b) => {
    if (b) cachePut(host, key, pack(b));
    return b;
  });
  c.pending.set(key, q);
  void q.finally(() => c.pending.delete(key)).catch(() => {});
  return q;
}

async function fetchIcon(s: Session, spec: string): Promise<Blob | undefined> {
  if (win(s)) {
    const r = json(await s.call("icon", spec));
    return typeof r?.png === "string" && r.png ? { type: "image/png", bytes: Buffer.from(r.png, "base64") } : undefined;
  }
  let path = "";
  if (spec.startsWith("p:")) path = spec.slice(2);
  else if (spec.startsWith("x:")) {
    const [theme, names] = spec.slice(2).split("|");
    path = (await s.call("icon", `${theme}\n${(names ?? "").split(",").join("\n")}`)).trim();
  }
  if (!path) return;
  const b = await readAll(s, path, iconMax);
  return { type: sniff(b, path), bytes: b };
}

// the icons a desk draws first, fetched and cached before the page asks: one
// request for all of them on Windows, pipelined on Linux
export async function prefetch(s: Session, host: string, items: Item[]): Promise<void> {
  const c = ctxOf(s);
  const want = new Map<string, string>();
  for (const it of items) {
    if (!it.icon || !c.icons.has(it.icon)) continue;
    const key = iconKey(it.icon, it.iv ?? "");
    if (!c.pending.has(key) && !cacheGet(host, key)) want.set(key, it.icon);
  }
  if (!want.size) return;
  if (!win(s)) {
    await Promise.allSettled([...want].map(([key, spec]) => track(c, key, host, fetchIcon(s, spec))));
    return;
  }
  const specs = [...new Set(want.values())];
  const all = s.call("icons", JSON.stringify(specs), 120_000).then((t) => {
    const m = new Map<string, Blob>();
    for (const r of json(t) as { k?: string; png?: string }[])
      if (r?.k && r.png) m.set(r.k, { type: "image/png", bytes: Buffer.from(r.png, "base64") });
    return m;
  });
  await Promise.allSettled(
    [...want].map(([key, spec]) =>
      track(
        c,
        key,
        host,
        all.then((m) => m.get(spec)),
      ),
    ),
  );
}

// a blob kept as one file: its type, a newline, its bytes
const pack = (b: Blob) => Buffer.concat([Buffer.from(`${b.type}\n`), b.bytes]);
function unpack(b: Uint8Array): Blob {
  const i = b.indexOf(10);
  return { type: Buffer.from(b.subarray(0, i)).toString(), bytes: b.subarray(i + 1) };
}

export async function wallpaper(s: Session, host: string): Promise<Blob | undefined> {
  const c = ctxOf(s);
  const w = c.desk?.wallpaper;
  if (!w?.path) return;
  const key = `wall\0${w.path}\0${w.iv}`;
  const hit = cacheGet(host, key);
  if (hit && w.iv) return unpack(hit);
  const b = await readAll(s, w.path, wallMax);
  const blob = { type: sniff(b, w.path), bytes: b };
  if (w.iv || !win(s)) cachePut(host, key, pack(blob));
  return blob;
}

// --- sftp ---------------------------------------------------------------------------

const sp = (s: Session, p: string) => sftpPath(p, win(s));

export async function statOf(s: Session, p: string): Promise<{ size: number; dir: boolean; mtime: number }> {
  const f = await s.sftp();
  const st = await new Promise<import("ssh2").Stats>((res, rej) => f.stat(sp(s, p), (e, x) => (e ? rej(e) : res(x))));
  return { size: st.size, dir: st.isDirectory(), mtime: st.mtime * 1000 };
}

export async function readAll(s: Session, p: string, max: number): Promise<Uint8Array> {
  const f = await s.sftp();
  const st = await statOf(s, p);
  if (st.size > max) throw new Error(`${baseName(p)} is too big`);
  return new Promise((res, rej) => f.readFile(sp(s, p), (e, b) => (e ? rej(e) : res(b))));
}

// a file as a stream of its bytes, its size first
export async function readStream(s: Session, p: string): Promise<{ size: number; body: ReadableStream<Uint8Array> }> {
  const f: SFTPWrapper = await s.sftp();
  const st = await statOf(s, p);
  if (st.dir) throw new Error(`${baseName(p)} is a folder`);
  const rs = f.createReadStream(sp(s, p));
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      rs.on("data", (b: Buffer) => ctl.enqueue(new Uint8Array(b)));
      rs.on("end", () => ctl.close());
      rs.on("error", (e: Error) => ctl.error(e));
    },
    cancel() {
      rs.destroy();
    },
  });
  return { size: st.size, body };
}

export async function writeText(s: Session, p: string, text: string): Promise<void> {
  const f = await s.sftp();
  await new Promise<void>((res, rej) => f.writeFile(sp(s, p), Buffer.from(text, "utf8"), (e) => (e ? rej(e) : res())));
}

// --- folders and files ----------------------------------------------------------------

const call = <T>(f: (cb: (e: Error | null | undefined, v?: T) => void) => void) =>
  new Promise<T>((res, rej) => f((e, v) => (e ? rej(e) : res(v as T))));

export async function mkdir(s: Session, p: string): Promise<void> {
  const f = await s.sftp();
  await call<void>((cb) => f.mkdir(sp(s, p), cb));
}

export async function rename(s: Session, from: string, to: string): Promise<void> {
  const f = await s.sftp();
  await call<void>((cb) => f.rename(sp(s, from), sp(s, to), cb));
}

// a file copied on the host, its bytes passing through this connection
export async function copyFile(s: Session, from: string, to: string): Promise<void> {
  const f = await s.sftp();
  if ((await statOf(s, from)).dir) throw new Error("folders are moved on a host's disk, not copied");
  await new Promise<void>((res, rej) => {
    const r = f.createReadStream(sp(s, from));
    const w = f.createWriteStream(sp(s, to));
    r.on("error", rej);
    w.on("error", rej);
    w.on("close", () => res());
    r.pipe(w);
  });
}

// one piece of an upload at its offset, the file made new by the first
export async function writeAt(s: Session, p: string, offset: number, data: Uint8Array): Promise<void> {
  const f = await s.sftp();
  const h = await call<Buffer>((cb) => f.open(sp(s, p), offset ? "r+" : "w", cb));
  try {
    let at = 0;
    while (at < data.length) {
      const n = Math.min(32 * 1024, data.length - at);
      await call<void>((cb) => f.write(h, Buffer.from(data.buffer, data.byteOffset + at, n), 0, n, offset + at, cb));
      at += n;
    }
  } finally {
    await call<void>((cb) => f.close(h, cb)).catch(() => {});
  }
}

export async function ls(s: Session, p: string): Promise<Entry[]> {
  let out: Entry[];
  if (win(s))
    out = (json(await s.call("ls", p)) as any[]).map((e) => ({
      name: e.name,
      path: e.path,
      dir: !!e.dir,
      size: Number(e.size) || 0,
      mtime: Number(e.mtime) || 0,
    }));
  else
    out = records(await s.call("ls", p))
      .filter((r) => r.kind === "ent")
      .map((r) => ({
        name: baseName(r.args[0] ?? ""),
        path: r.args[0] ?? "",
        dir: r.args[1] === "d",
        mtime: Number(r.args[2]) * 1000 || 0,
        size: Number(r.args[3]) || 0,
      }));
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

// where the file system starts: a Windows host's drives, a Linux host's root and its mounted disks
export async function roots(s: Session): Promise<Root[]> {
  if (win(s))
    return (json(await s.call("roots")) as any[]).map((r) => ({
      name: String(r.name),
      path: String(r.path),
      label: String(r.label ?? ""),
      size: Number(r.size) || 0,
      free: Number(r.free) || 0,
    }));
  return parseDf(await s.call("roots"));
}

// df -kP: the root first, then each disk's mount; loops, snaps and boot partitions left out
export function parseDf(text: string): Root[] {
  const out: Root[] = [{ name: "/", path: "/", label: "", size: 0, free: 0 }];
  for (const l of text.split("\n").slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [dev = "", blocks, , avail] = f;
    const at = f.slice(5).join(" ");
    if (!dev.startsWith("/dev/") || dev.startsWith("/dev/loop")) continue;
    if (/^\/(boot|snap)(\/|$)/.test(at)) continue;
    const r = { name: at, path: at, label: dev, size: Number(blocks) * 1024 || 0, free: Number(avail) * 1024 || 0 };
    if (at === "/") out[0] = r;
    else if (!out.some((x) => x.path === at)) out.push(r);
  }
  return out;
}

// a path as the desktop opens it: kind, what it runs
export async function open(s: Session, p: string): Promise<Item> {
  const c = ctxOf(s);
  let it: Item;
  if (win(s)) it = winItem(json(await s.call("open", p)), c.psTerm || c.desk?.sshShell === "powershell");
  else {
    const recs = records(await s.call("open", p));
    const st = recs.find((r) => r.kind === "stat");
    const f = recs.find((r) => r.kind === "file");
    const e = f && parseEntry(f.body);
    if (e) {
      const { entry: _e, ...x } = appItem(e, baseName(p), p, st?.args[1] ?? "", c.desk?.icontheme ?? "hicolor");
      it = x;
    } else it = { name: baseName(p), path: p, kind: st?.args[0] === "d" ? "folder" : "file" };
  }
  issue(c, [it]);
  return it;
}

// a file or folder to the recycle bin, never removed outright
export async function remove(s: Session, p: string, now = Date.now()): Promise<void> {
  if (win(s)) {
    const st = json(await s.call("stat", p, 120_000));
    if (!st?.bin) throw new Error(`${p.slice(0, 2)} has no recycle bin for this login, so nothing was deleted`);
    const name = binName(String(st.path), (n) => randomInt(n));
    const info = Buffer.from(writeInfo({ path: String(st.path), size: Number(st.size) || 0, deleted: now })).toString(
      "base64",
    );
    await s.call("delete", JSON.stringify({ path: String(st.path), bin: st.bin, name, info }));
  } else await s.call("delete", `${p}\n${trashInfo(p, now)}`);
}
