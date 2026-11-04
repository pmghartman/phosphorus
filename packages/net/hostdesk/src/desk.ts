// what the page asks of a host's desktop, each through its session's probe or sftp,
// every path kept to the login's scope

import { randomInt } from "node:crypto";
import type { SFTPWrapper } from "ssh2";
import { cacheGet, cachePut } from "./cache.ts";
import {
  type App,
  appItem,
  buildDesk,
  fileUri,
  gArray,
  gQuote,
  kdeScript,
  parseApps,
  parseEntry,
  parseTrashInfo,
  trashInfo,
  xfconf,
} from "./linux.ts";
import type { BinItem, Change, Desk, Entry, Item } from "./model.ts";
import { baseName, Scope, sftpPath } from "./paths.ts";
import { records } from "./proto.ts";
import { binName, writeInfo } from "./recycle.ts";
import type { Session } from "./session.ts";
import { winDesk, winItem, winTrash } from "./windows.ts";

// Ctx what a session keeps between calls
type Ctx = {
  scope: Scope;
  icons: Set<string>;
  desk?: Desk;
  apps?: Item[];
  // a linux desktop's raw records, for settings changes
  raw?: ReturnType<typeof buildDesk> & { files: Map<string, string> };
  // the host runs phosphorus: a terminal there opens powershell
  psTerm: boolean;
  // the recycle bin as last listed: id to where it came from
  bin?: Record<string, string>;
  // icons on their way, by cache key
  pending: Map<string, Promise<Blob | undefined>>;
};

const win = (s: Session) => s.os === "windows";

export function ctxOf(s: Session, psTerm = false): Ctx {
  s.extra.ctx ??= { scope: new Scope("", win(s)), icons: new Set<string>(), psTerm, pending: new Map() } satisfies Ctx;
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
    if (it.path) c.scope.issue(it.path, it.kind === "folder");
  }
}

// the desktop as drawn: wallpaper, theme, icons, pins
export async function desktop(s: Session): Promise<Desk> {
  const c = ctxOf(s);
  let d: Desk;
  if (win(s)) {
    const o = json(await s.call("desktop"));
    d = winDesk(o, c.psTerm);
    c.scope = new Scope(d.home, true);
    for (const dir of Array.isArray(o.desktops) ? o.desktops : []) c.scope.issue(String(dir), true);
  } else {
    const [dt, ap] = await Promise.all([s.call("desktop"), s.call("apps", "", 120_000)]);
    const recs = records(dt);
    const de = /\nde=(\w+)/.exec(`\n${recs.find((r) => r.kind === "env")?.body ?? ""}`)?.[1] ?? "plain";
    const pre = buildDesk(recs, []);
    const apps = parseApps(records(ap), de, pre.desk.icontheme ?? "hicolor");
    const b = buildDesk(recs, apps);
    d = b.desk;
    c.raw = { ...b, files: new Map(recs.filter((r) => r.kind === "file").map((r) => [r.args[0] ?? "", r.body])) };
    c.apps = apps.map(({ entry: _e, ...it }: App) => it);
    c.scope = new Scope(d.home, false);
    c.scope.issue(b.deskDir, true);
    issue(c, c.apps);
  }
  c.desk = d;
  issue(c, [...d.icons, ...d.pins]);
  if (d.wallpaper.path) c.scope.issue(d.wallpaper.path);
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

export async function ls(s: Session, p: string): Promise<Entry[]> {
  const c = ctxOf(s);
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
  for (const e of out) c.scope.issue(e.path, e.dir);
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
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

export async function images(s: Session): Promise<string[]> {
  const c = ctxOf(s);
  const list = win(s)
    ? (json(await s.call("images")) as string[])
    : (await s.call("images")).split("\n").filter((l) => l.startsWith("/"));
  for (const p of list) c.scope.issue(p);
  return list;
}

// --- the recycle bin ------------------------------------------------------------------

export async function trash(s: Session): Promise<BinItem[]> {
  const c = ctxOf(s);
  let out: BinItem[];
  if (win(s)) out = winTrash(json(await s.call("trash")));
  else
    out = records(await s.call("trash"))
      .filter((r) => r.kind === "item")
      .flatMap((r) => {
        const info = parseTrashInfo(r.body);
        const name = r.args[0] ?? "";
        if (!info || !name) return [];
        return [
          {
            id: name,
            name: baseName(info.path),
            from: info.path,
            deleted: info.deleted,
            size: (Number(r.args[2]) || 0) * 1024,
            dir: r.args[1] === "d",
          },
        ];
      })
      .sort((a, b) => b.deleted - a.deleted);
  c.bin = Object.fromEntries(out.map((b) => [b.id, b.from]));
  return out;
}

// one item back where it was deleted from
export async function restore(s: Session, id: string): Promise<string> {
  const c = ctxOf(s);
  if (!c.bin) await trash(s);
  const from = c.bin?.[id];
  if (!from) throw new Error("not in the recycle bin");
  if (win(s)) {
    const i = id.lastIndexOf("|");
    await s.call("restore", JSON.stringify({ bin: id.slice(0, i), i: id.slice(i + 1), to: from }));
  } else await s.call("restore", `${id}\n${from}`);
  delete c.bin![id];
  return from;
}

export async function empty(s: Session): Promise<void> {
  await s.call("empty", "", 300_000);
  ctxOf(s).bin = undefined;
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

// --- settings changes -----------------------------------------------------------------

// a change written back to the host's own settings; false when it applies at next sign in
export async function change(s: Session, ch: Change): Promise<boolean> {
  const c = ctxOf(s);
  const d = c.desk ?? (await desktop(s));
  if (ch.wallpaper !== undefined && !c.scope.allow(ch.wallpaper)) throw new Error("not a picture on this host");
  if (ch.accent !== undefined && !/^#[0-9a-f]{6}$/i.test(ch.accent) && !d.accents.includes(ch.accent))
    throw new Error("not an accent colour");
  if (win(s)) {
    if (ch.pins) throw new Error("windows keeps its taskbar pins to itself; pin and unpin on the host");
    const r = json(await s.call("set", JSON.stringify({ wallpaper: ch.wallpaper, dark: ch.dark, accent: ch.accent })));
    return r?.live === true;
  }
  const ops = linuxOps(d, c.raw, ch);
  await s.call("set", ops.join("\n"));
  return true;
}

// the probe's set lines for a change on this desktop
export function linuxOps(d: Desk, raw: Ctx["raw"], ch: Change): string[] {
  const ops: string[] = [];
  const no = (what: string) => {
    throw new Error(`${what} can't be changed on ${d.shell} from here`);
  };
  if (d.shell === "gnome") {
    if (ch.wallpaper !== undefined) {
      const u = gQuote(fileUri(ch.wallpaper));
      ops.push(
        `gs\torg.gnome.desktop.background\tpicture-uri\t${u}`,
        `gs\torg.gnome.desktop.background\tpicture-uri-dark\t${u}`,
      );
    }
    if (ch.dark !== undefined) {
      ops.push(`gs\torg.gnome.desktop.interface\tcolor-scheme\t${gQuote(ch.dark ? "prefer-dark" : "default")}`);
    }
    if (ch.accent !== undefined) {
      if (!d.can.accent) no("the accent");
      ops.push(`gs\torg.gnome.desktop.interface\taccent-color\t${gQuote(ch.accent)}`);
    }
    if (ch.pins) ops.push(`gs\torg.gnome.shell\tfavorite-apps\t${gArray(ch.pins)}`);
  } else if (d.shell === "kde") {
    if (ch.wallpaper !== undefined || ch.pins) {
      const js = kdeScript({ wallpaper: ch.wallpaper, pins: ch.pins });
      ops.push(`kde-js\t${Buffer.from(js, "utf8").toString("base64")}`);
    }
    if (ch.dark !== undefined) ops.push(`kde-scheme\t${ch.dark ? "BreezeDark" : "BreezeLight"}`);
    if (ch.accent !== undefined) ops.push(`kde-accent\t${ch.accent}`);
  } else if (d.shell === "xfce") {
    if (ch.pins) no("panel launchers");
    if (ch.accent !== undefined) no("the accent");
    if (ch.wallpaper !== undefined) {
      const xml = [...(raw?.files ?? new Map())].find(([p]) => p.endsWith("/xfce4-desktop.xml"))?.[1] ?? "";
      const props = [...xfconf(xml).keys()].filter((k) => k.endsWith("/last-image"));
      if (!props.length) props.push("/backdrop/screen0/monitor0/workspace0/last-image");
      for (const p of props) ops.push(`xf\txfce4-desktop\t${p}\tstring\t${ch.wallpaper}`);
    }
    if (ch.dark !== undefined) {
      const xml = [...(raw?.files ?? new Map())].find(([p]) => p.endsWith("/xsettings.xml"))?.[1] ?? "";
      const cur = xfconf(xml).get("/Net/ThemeName") || "Adwaita";
      const base = cur.replace(/-dark$/i, "");
      ops.push(`xf\txsettings\t/Net/ThemeName\tstring\t${ch.dark ? `${base}-dark` : base}`);
    }
  } else no("settings");
  if (!d.can.wallpaper && ch.wallpaper !== undefined) no("the wallpaper");
  for (const o of ops) if (/[\n\r]/.test(o)) throw new Error("bad value");
  return ops;
}
