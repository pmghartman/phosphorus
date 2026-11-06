// appstream's host half: one GUI app on its own Xvfb as the viewer's login, its window manager,
// XTEST input, title, windows, cursor, clipboard, and pixels as the XDamage rectangles that change

// stdin: the start line {"argv","w","h","sw","sh","dpi","scale","dbus"}, then input arrays (xsource.ts);
// stdout: JSON lines, a "rect" line followed by its n bytes of 32 bit pixels, zlib deflated when z

// run as bun by the host's own phosphorus (BUN_BE_BUN=1 phosphorus -e), bun's builtins only;
// libX11, libXtst, libXfixes, libXdamage through bun:ffi, structs laid out for LP64

import { CString, dlopen, JSCallback, toArrayBuffer } from "bun:ffi";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, constants as osc, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// rectangles merged where they touch (within pad), the lot's bounding box when still
// more than limit: few reads, little sent twice
export function mergeRects(rs, limit = 8, pad = 2) {
  let bs = rs.filter(([, , w, h]) => w > 0 && h > 0).map(([x, y, w, h]) => [x, y, x + w, y + h]);
  let changed = true;
  while (changed && bs.length > 1) {
    changed = false;
    const done = [];
    while (bs.length) {
      let a = bs.pop();
      let i = 0;
      while (i < bs.length) {
        const b = bs[i];
        if (a[0] - pad < b[2] && b[0] - pad < a[2] && a[1] - pad < b[3] && b[1] - pad < a[3]) {
          a = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
          bs.splice(i, 1);
          changed = true;
        } else i++;
      }
      done.push(a);
    }
    bs = done;
  }
  if (bs.length > limit)
    bs = [
      [
        Math.min(...bs.map((b) => b[0])),
        Math.min(...bs.map((b) => b[1])),
        Math.max(...bs.map((b) => b[2])),
        Math.max(...bs.map((b) => b[3])),
      ],
    ];
  return bs.map(([x0, y0, x1, y1]) => [x0, y0, x1 - x0, y1 - y0]);
}

// blocks in poll(2) on the X connection, says when it's readable, then waits for the
// main thread to have drained Xlib's queue; 1 when the connection is gone
const POLLER = `import { dlopen } from "bun:ffi";
self.onmessage = (e) => {
  const { fd, sab } = e.data;
  const gate = new Int32Array(sab);
  const { symbols: c } = dlopen("libc.so.6", { poll: { args: ["ptr", "u64", "i32"], returns: "i32" } });
  const p = new Uint8Array(8);
  const v = new DataView(p.buffer);
  v.setInt32(0, fd, true);
  v.setInt16(4, 1, true);
  for (;;) {
    v.setInt16(6, 0, true);
    if (c.poll(p, 1, -1) < 0) continue;
    if (v.getInt16(6, true) & 0x38) return postMessage(1);
    Atomics.store(gate, 0, 0);
    postMessage(0);
    Atomics.wait(gate, 0, 0);
  }
};`;

const DestroyNotify = 17;
const UnmapNotify = 18;
const MapRequest = 20;
const ConfigureNotify = 22;
const ConfigureRequest = 23;
const PropertyNotify = 28;
const SelectionRequest = 30;
const SelectionNotify = 31;
const ClientMessage = 33;
const MappingNotify = 34;
const SubstructureRedirect = 1 << 20;
const SubstructureNotify = 1 << 19;
const StructureNotify = 1 << 17;
const PropertyChange = 1 << 22;
const CWX = 1;
const CWY = 2;
const CWWidth = 4;
const CWHeight = 8;
// changes gathered this long before they're read: one read for a burst of drawing
const GATHER = 5;
// and read no more often than this: a flood of change stays a stream of rectangles
const FLUSH_GAP = 8;
const MOTION_EVERY = 500;
const TICK = 250;

const enc = new TextEncoder();
const EMPTY = new Uint8Array(0);
const cut = (s) => Array.from(s).slice(0, 300).join("");

const W = "u64";
const P = "ptr";
const I = "i32";
const xsyms = {
  XOpenDisplay: { args: [P], returns: P },
  XDefaultRootWindow: { args: [P], returns: "u64_fast" },
  XConnectionNumber: { args: [P], returns: I },
  XInternAtom: { args: [P, P, I], returns: "u64_fast" },
  XGetAtomName: { args: [P, W], returns: P },
  XFree: { args: [P], returns: I },
  XSelectInput: { args: [P, W, "i64"], returns: I },
  XPending: { args: [P], returns: I },
  XNextEvent: { args: [P, P], returns: I },
  XMapWindow: { args: [P, W], returns: I },
  XRaiseWindow: { args: [P, W], returns: I },
  XMoveResizeWindow: { args: [P, W, I, I, "u32", "u32"], returns: I },
  XConfigureWindow: { args: [P, W, "u32", P], returns: I },
  XSetInputFocus: { args: [P, W, I, W], returns: I },
  XGetWindowAttributes: { args: [P, W, P], returns: I },
  XGetTransientForHint: { args: [P, W, P], returns: I },
  XGetWindowProperty: { args: [P, W, W, "i64", "i64", I, W, P, P, P, P, P], returns: I },
  XChangeProperty: { args: [P, W, W, W, I, I, P, I], returns: I },
  XSendEvent: { args: [P, W, I, "i64", P], returns: I },
  XKillClient: { args: [P, W], returns: I },
  XFlush: { args: [P], returns: I },
  XSync: { args: [P, I], returns: I },
  XQueryPointer: { args: [P, W, P, P, P, P, P, P, P], returns: I },
  XDisplayKeycodes: { args: [P, P, P], returns: I },
  XGetKeyboardMapping: { args: [P, "u8", I, P], returns: P },
  XChangeKeyboardMapping: { args: [P, I, I, P, I], returns: I },
  XCreateSimpleWindow: { args: [P, W, I, I, "u32", "u32", "u32", W, W], returns: "u64_fast" },
  XSetSelectionOwner: { args: [P, W, W, W], returns: I },
  XConvertSelection: { args: [P, W, W, W, W, W], returns: I },
  XDeleteProperty: { args: [P, W, W], returns: I },
  XGetImage: { args: [P, W, I, I, "u32", "u32", W, I], returns: P },
  XDestroyImage: { args: [P], returns: I },
  XSetErrorHandler: { args: [P], returns: P },
};
const tsyms = {
  XTestFakeMotionEvent: { args: [P, I, I, I, W], returns: I },
  XTestFakeButtonEvent: { args: [P, "u32", I, W], returns: I },
  XTestFakeKeyEvent: { args: [P, "u32", I, W], returns: I },
};
const fsyms = {
  XFixesQueryExtension: { args: [P, P, P], returns: I },
  XFixesSelectCursorInput: { args: [P, W, W], returns: "void" },
  XFixesGetCursorImage: { args: [P], returns: P },
  XFixesSelectSelectionInput: { args: [P, W, W, W], returns: "void" },
};
const dsyms = {
  XDamageQueryExtension: { args: [P, P, P], returns: I },
  XDamageCreate: { args: [P, W, I], returns: "u64_fast" },
  XDamageSubtract: { args: [P, W, W, W], returns: "void" },
};
const csyms = {
  setenv: { args: [P, P, I], returns: I },
  waitpid: { args: [I, P, I], returns: I },
  poll: { args: [P, "u64", I], returns: I },
};

function lib(name, syms) {
  for (const c of [`lib${name}.so.6`, `lib${name}.so.3`, `lib${name}.so.1`, `lib${name}.so`]) {
    try {
      return dlopen(c, syms).symbols;
    } catch {}
  }
  return null;
}

const cstr = (s) => Buffer.from(`${s}\0`);

let X = null;
let Xt = null;
let Xf = null;
let Xd = null;
let C = null;
let dpy = 0;
let root = 0;
let proc = null;
let procExit = null;
let xvfb = null;
let tmp = "";
let applog = Buffer.alloc(0);
let sw = 1920;
let sh = 1080;
let errh = null;

// --- out --------------------------------------------------------------------------

// blocking, as the pipe allows: a slow viewer holds the next read back
function write(b) {
  let off = 0;
  while (off < b.length) {
    try {
      off += writeSync(1, b, off);
    } catch (e) {
      if (e?.code !== "EAGAIN" || !C) shutdown(0);
      // fd 1, POLLOUT
      C.poll(new Uint8Array([1, 0, 0, 0, 4, 0, 0, 0]), 1, -1);
    }
  }
}

const out = (m) => write(enc.encode(`${JSON.stringify(m)}\n`));
const logText = (n) => applog.subarray(-n).toString("utf8");

function fail(msg) {
  out({ t: "exit", code: -1, error: msg, log: logText(4000) });
  shutdown(1);
}

// a child gone yet, reaped here: Bun's own loop never runs again before exit
function gone(pid) {
  const st = new Int32Array(1);
  const r = C.waitpid(pid, st, 1);
  return r === pid || r < 0;
}

function shutdown(code) {
  try {
    if (proc && procExit === null && proc.pid) {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 20 && !gone(proc.pid); i++) Bun.sleepSync(100);
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    }
    if (xvfb && xvfb.exitCode === null) {
      xvfb.kill("SIGTERM");
      let i = 0;
      while (i++ < 20 && !gone(xvfb.pid)) Bun.sleepSync(100);
      if (i > 20) xvfb.kill("SIGKILL");
    }
  } catch {}
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}

// --- the display ------------------------------------------------------------------

function freeDisplay() {
  for (let n = 100; n < 400; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  fail("no free X display number");
}

// FamilyWild: any address, this display
function writeAuth(path, n, cookie) {
  const f = (b) => {
    const h = Buffer.alloc(2);
    h.writeUInt16BE(b.length);
    return Buffer.concat([h, b]);
  };
  const fam = Buffer.from([0xff, 0xff]);
  writeFileSync(
    path,
    Buffer.concat([fam, f(EMPTY), f(Buffer.from(String(n))), f(Buffer.from("MIT-MAGIC-COOKIE-1")), f(cookie)]),
  );
  chmodSync(path, 0o600);
}

const writable = (d) => {
  try {
    accessSync(d, constants.W_OK);
    return statSync(d).isDirectory();
  } catch {
    return false;
  }
};

async function startXvfb(dpi) {
  const bin = Bun.which("Xvfb");
  if (!bin) fail("Xvfb isn't installed on this host (apt install xvfb)");
  const base =
    process.env.XDG_RUNTIME_DIR && writable(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : tmpdir();
  tmp = mkdtempSync(join(base, "phos-app-"));
  const auth = join(tmp, "Xauthority");
  // killed with this process however it ends
  const guard = Bun.which("setpriv") ? ["setpriv", "--pdeathsig", "KILL"] : [];
  for (let k = 0; k < 5; k++) {
    const n = freeDisplay();
    writeAuth(auth, n, randomBytes(16));
    const args = [`:${n}`, "-screen", "0", `${sw}x${sh}x24`, "-auth", auth, "-nolisten", "tcp"];
    args.push("-dpi", String(dpi), "-noreset", "+extension", "RANDR");
    xvfb = Bun.spawn([...guard, bin, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    C.setenv(cstr("XAUTHORITY"), cstr(auth), 1);
    process.env.XAUTHORITY = auth;
    for (let i = 0; i < 100; i++) {
      if (xvfb.exitCode !== null) break;
      if (existsSync(`/tmp/.X11-unix/X${n}`)) {
        const d = X.XOpenDisplay(cstr(`:${n}`));
        if (d) {
          void new Response(xvfb.stderr).arrayBuffer().catch(() => {});
          return [n, auth, d];
        }
      }
      await Bun.sleep(50);
    }
    if (xvfb.exitCode === null) xvfb.kill("SIGKILL");
    await xvfb.exited;
    const err = await new Response(xvfb.stderr).text().catch(() => "");
    if (!err.includes("already active") && !err.includes("Server is already"))
      fail(`Xvfb didn't start: ${err.slice(-600)}`);
  }
  fail("Xvfb didn't start");
}

const atoms = new Map();
function atom(name) {
  let a = atoms.get(name);
  if (a === undefined) {
    a = X.XInternAtom(dpy, cstr(name), 0);
    atoms.set(name, a);
  }
  return a;
}

const names = new Map();
function atomName(a) {
  if (!a) return "";
  let s = names.get(a);
  if (s !== undefined) return s;
  const p = X.XGetAtomName(dpy, a);
  if (!p) return "";
  s = new CString(p).toString();
  X.XFree(p);
  names.set(a, s);
  return s;
}

function prop(w, name, kind = 0, maxlen = 65536) {
  const t = new BigUint64Array(1);
  const f = new Int32Array(1);
  const n = new BigUint64Array(1);
  const left = new BigUint64Array(1);
  const data = new BigUint64Array(1);
  const a = typeof name === "string" ? atom(name) : name;
  if (X.XGetWindowProperty(dpy, w, a, 0, Math.floor(maxlen / 4), 0, kind, t, f, n, left, data) !== 0 || !data[0])
    return [0, 0, EMPTY];
  const p = Number(data[0]);
  const len = Number(n[0]) * (f[0] === 16 ? 2 : f[0] === 32 ? 8 : 1);
  const raw = len ? new Uint8Array(toArrayBuffer(p, 0, len)).slice() : EMPTY;
  X.XFree(p);
  return [Number(t[0]), f[0], raw];
}

function atomsOf(w, name) {
  const [, f, raw] = prop(w, name);
  if (f !== 32) return [];
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const r = [];
  for (let i = 0; i + 8 <= raw.length; i += 8) r.push(Number(dv.getBigUint64(i, true)));
  return r;
}

const ESC_SET = new RegExp(`${String.fromCharCode(27)}[-(][A-Z@]`, "g");

function titleOf(w) {
  let [, , raw] = prop(w, "_NET_WM_NAME");
  if (!raw.length) {
    let t;
    [t, , raw] = prop(w, "WM_NAME");
    const tn = t ? atomName(t) : "";
    // COMPOUND_TEXT: UTF-8 runs between ESC % G and ESC % @, Latin-1 outside
    if (tn === "COMPOUND_TEXT") {
      let s = "";
      Buffer.from(raw)
        .toString("latin1")
        .split("\x1b%G")
        .forEach((part, i) => {
          const j = i ? part.indexOf("\x1b%@") : -1;
          const utf = i ? (j < 0 ? part : part.slice(0, j)) : "";
          const rest = i ? (j < 0 ? "" : part.slice(j + 3)) : part;
          s += Buffer.from(utf, "latin1").toString("utf8") + rest.replace(ESC_SET, "");
        });
      return cut(s);
    }
    if (tn === "STRING") return cut(Buffer.from(raw).toString("latin1"));
  }
  return cut(Buffer.from(raw).toString("utf8"));
}

// an XEvent's worth, read and written in place
const ev = new Uint8Array(192);
const ed = new DataView(ev.buffer);
const u64 = (dv, o) => Number(dv.getBigUint64(o, true));
const setU64 = (dv, o, v) => dv.setBigUint64(o, BigInt(v), true);

function event() {
  const b = new Uint8Array(192);
  return [b, new DataView(b.buffer)];
}

// --- the window manager -------------------------------------------------------------

let vw = 800;
let vh = 600;
// managed, bottom to top
const wins = [];
// those that fill the viewport
const full = new Set();
// each one's x, y, w, h as last set
const geo = new Map();
let mainwin = 0;
let lastTitle = null;
let lastList = null;

function attrs(w) {
  const b = new Uint8Array(136);
  const ok = X.XGetWindowAttributes(dpy, w, b);
  const dv = new DataView(b.buffer);
  return { ok, width: dv.getInt32(8, true), height: dv.getInt32(12, true), override: dv.getInt32(120, true) };
}

const DIALOGS = new Set([
  "_NET_WM_WINDOW_TYPE_DIALOG",
  "_NET_WM_WINDOW_TYPE_UTILITY",
  "_NET_WM_WINDOW_TYPE_SPLASH",
  "_NET_WM_WINDOW_TYPE_TOOLBAR",
  "_NET_WM_WINDOW_TYPE_NOTIFICATION",
]);

function isDialog(w) {
  const tf = new BigUint64Array(1);
  if (X.XGetTransientForHint(dpy, w, tf) && tf[0]) return true;
  return atomsOf(w, "_NET_WM_WINDOW_TYPE").some((a) => DIALOGS.has(atomName(a)));
}

function place(w, rw, rh, rx, ry) {
  let x;
  let y;
  let ww;
  let hh;
  if (full.has(w)) [x, y, ww, hh] = [0, 0, vw, vh];
  else {
    const a = attrs(w);
    ww = Math.max(1, Math.min(rw || a.width, vw));
    hh = Math.max(1, Math.min(rh || a.height, vh));
    if (rx != null && ry != null) [x, y] = [Math.max(0, Math.min(rx, vw - ww)), Math.max(0, Math.min(ry, vh - hh))];
    else [x, y] = [Math.floor((vw - ww) / 2), Math.floor((vh - hh) / 2)];
  }
  geo.set(w, [x, y, ww, hh]);
  X.XMoveResizeWindow(dpy, w, x, y, ww, hh);
  syntheticConfigure(w);
}

// ICCCM: a client told where it is even when its request wasn't the answer
function syntheticConfigure(w) {
  const [x, y, ww, hh] = geo.get(w);
  const [b, dv] = event();
  dv.setInt32(0, ConfigureNotify, true);
  setU64(dv, 32, w);
  setU64(dv, 40, w);
  dv.setInt32(48, x, true);
  dv.setInt32(52, y, true);
  dv.setInt32(56, ww, true);
  dv.setInt32(60, hh, true);
  X.XSendEvent(dpy, w, 0, StructureNotify, b);
}

function focus(w) {
  const i = wins.indexOf(w);
  if (i >= 0) {
    wins.splice(i, 1);
    wins.push(w);
  }
  X.XRaiseWindow(dpy, w);
  X.XSetInputFocus(dpy, w, 1, 0);
}

function manage(w) {
  const a = attrs(w);
  if (!a.ok || a.override) {
    X.XMapWindow(dpy, w);
    return;
  }
  if (!wins.includes(w)) {
    wins.push(w);
    if (!isDialog(w)) full.add(w);
    X.XSelectInput(dpy, w, PropertyChange | StructureNotify);
  }
  place(w);
  X.XMapWindow(dpy, w);
  focus(w);
  pickMain();
}

function unmanage(w) {
  const i = wins.indexOf(w);
  if (i < 0) return;
  wins.splice(i, 1);
  full.delete(w);
  geo.delete(w);
  if (wins.length) X.XSetInputFocus(dpy, wins.at(-1), 1, 0);
  pickMain();
}

function pickMain() {
  const tops = wins.filter((w) => full.has(w));
  mainwin = tops.length ? tops.at(-1) : wins.length ? wins.at(-1) : 0;
  report();
}

function report() {
  const t = mainwin ? titleOf(mainwin) : "";
  if (t !== lastTitle) {
    lastTitle = t;
    out({ t: "title", s: t });
  }
  const list = wins.map((w) => [w, titleOf(w)]);
  const key = JSON.stringify(list);
  if (key !== lastList) {
    lastList = key;
    out({ t: "windows", list, main: mainwin });
  }
}

function resizeView(w, h) {
  vw = Math.max(64, Math.min(w, sw));
  vh = Math.max(64, Math.min(h, sh));
  for (const x of wins) place(x);
  if (pixelsOn) refresh();
}

function closeMain() {
  const w = wins.at(-1);
  if (!w) return;
  if (atomsOf(w, "WM_PROTOCOLS").includes(atom("WM_DELETE_WINDOW"))) {
    const [b, dv] = event();
    dv.setInt32(0, ClientMessage, true);
    setU64(dv, 32, w);
    setU64(dv, 40, atom("WM_PROTOCOLS"));
    dv.setInt32(48, 32, true);
    setU64(dv, 56, atom("WM_DELETE_WINDOW"));
    X.XSendEvent(dpy, w, 0, 0, b);
  } else X.XKillClient(dpy, w);
}

// --- the keyboard and pointer -------------------------------------------------------

let per = 1;
// keysym to [keycode, level]
const bySym = new Map();
let spare = [];
let spareI = 0;
// the viewer's key id to the keycode it pressed
const held = new Map();
let shiftKc = 50;
// the shift keycodes held
const shifts = new Set();

function loadKeymap() {
  const a = new Int32Array(1);
  const b = new Int32Array(1);
  X.XDisplayKeycodes(dpy, a, b);
  const kmin = a[0];
  const kmax = b[0];
  const n = new Int32Array(1);
  const count = kmax - kmin + 1;
  const m = X.XGetKeyboardMapping(dpy, kmin, count, n);
  per = n[0];
  bySym.clear();
  spare = [];
  if (m) {
    const all = new BigUint64Array(toArrayBuffer(m, 0, count * per * 8));
    for (let kc = kmin; kc <= kmax; kc++) {
      const syms = [];
      for (let i = 0; i < per; i++) syms.push(Number(all[(kc - kmin) * per + i]));
      if (!syms.some(Boolean)) spare.push(kc);
      syms.slice(0, 2).forEach((s, lvl) => {
        if (s && (!bySym.has(s) || bySym.get(s)[1] > lvl)) bySym.set(s, [kc, lvl]);
      });
    }
    X.XFree(m);
  }
  shiftKc = bySym.get(0xffe1)?.[0] ?? 50;
  spare = spare.slice(-8);
}

function remap(sym) {
  if (!spare.length) return 0;
  const kc = spare[spareI % spare.length];
  spareI++;
  X.XChangeKeyboardMapping(dpy, kc, 2, new BigUint64Array([BigInt(sym), BigInt(sym)]), 1);
  X.XSync(dpy, 0);
  for (const [s, v] of [...bySym]) if (v[0] === kc) bySym.delete(s);
  bySym.set(sym, [kc, 0]);
  return kc;
}

function key(down, kc, sym, kid) {
  if (!Xt) return;
  if (!down) {
    const k = held.has(kid) ? held.get(kid) : kc;
    held.delete(kid);
    if (k) {
      Xt.XTestFakeKeyEvent(dpy, k, 0, 0);
      shifts.delete(k);
    }
    return;
  }
  let k = 0;
  let lvl = -1;
  if (sym && bySym.has(sym)) [k, lvl] = bySym.get(sym);
  else if (sym && 0x20 <= sym % 0x1000000 && (sym < 0xff00 || sym >= 0x01000000)) k = remap(sym);
  if (!k) [k, lvl] = [kc, -1];
  if (!k) return;
  held.set(kid, k);
  // a character at the other shift level than the viewer's held shift: shift pressed
  // or let go around it, as their layout and this display's differ
  const press = lvl === 1 && !shifts.size;
  const lift = lvl === 0 && shifts.size > 0 && sym < 0xff00 ? [...shifts] : [];
  if (press) Xt.XTestFakeKeyEvent(dpy, shiftKc, 1, 0);
  for (const s of lift) Xt.XTestFakeKeyEvent(dpy, s, 0, 0);
  Xt.XTestFakeKeyEvent(dpy, k, 1, 0);
  if (press) Xt.XTestFakeKeyEvent(dpy, shiftKc, 0, 0);
  for (const s of lift) Xt.XTestFakeKeyEvent(dpy, s, 1, 0);
  if (sym === 0xffe1 || sym === 0xffe2 || (lvl < 0 && (kc === 50 || kc === 62))) shifts.add(k);
}

function symOf(ch) {
  const o = ch.codePointAt(0);
  if (ch === "\n") return 0xff0d;
  if (ch === "\t") return 0xff09;
  return (0x20 <= o && o <= 0x7e) || (0xa0 <= o && o <= 0xff) ? o : 0x01000000 + o;
}

function typeText(s) {
  for (const ch of Array.from(s).slice(0, 4096)) {
    const sym = symOf(ch);
    key(true, 0, sym, "_t");
    key(false, 0, sym, "_t");
    X.XFlush(dpy);
  }
}

function button(n, down) {
  if (!Xt || n < 1 || n > 9) return;
  if (down && n <= 3) {
    const r = new BigUint64Array(1);
    const c = new BigUint64Array(1);
    const i = new Int32Array(4);
    const u = new Uint32Array(1);
    X.XQueryPointer(dpy, root, r, c, i.subarray(0, 1), i.subarray(1, 2), i.subarray(2, 3), i.subarray(3, 4), u);
    const w = Number(c[0]);
    if (wins.includes(w) && w !== wins.at(-1)) {
      focus(w);
      report();
    }
  }
  Xt.XTestFakeButtonEvent(dpy, n, down ? 1 : 0, 0);
}

function wheel(dx, dy) {
  if (!Xt) return;
  for (const [n, count] of [
    [4, -dy],
    [5, dy],
    [6, -dx],
    [7, dx],
  ])
    for (let i = 0; i < Math.max(0, Math.min(Math.trunc(count), 20)); i++) {
      Xt.XTestFakeButtonEvent(dpy, n, 1, 0);
      Xt.XTestFakeButtonEvent(dpy, n, 0, 0);
    }
}

// --- the pointer's shape -------------------------------------------------------------

let lastCursor = null;

function png(w, h, raw) {
  const chunk = (k, d) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(d.length);
    const body = Buffer.concat([Buffer.from(k, "latin1"), d]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", EMPTY),
  ]);
}

function cursorChanged() {
  const img = Xf.XFixesGetCursorImage(dpy);
  if (!img) return;
  const dv = new DataView(toArrayBuffer(img, 0, 48));
  const w = dv.getUint16(4, true);
  const h = dv.getUint16(6, true);
  const np = u64(dv, 40);
  const name = np ? new CString(np).toString() : "";
  const k = name || u64(dv, 16);
  if (k === lastCursor) {
    X.XFree(img);
    return;
  }
  lastCursor = k;
  if (name) out({ t: "cursor", name });
  else if (w && h && w <= 128 && h <= 128) {
    // unsigned longs, the low 32 bits ARGB; premultiplied in the server, straight in a PNG
    const px = new Uint32Array(toArrayBuffer(u64(dv, 24), 0, w * h * 8));
    const raw = Buffer.alloc(h * (1 + w * 4));
    let o = 0;
    for (let y = 0; y < h; y++) {
      raw[o++] = 0;
      for (let x = 0; x < w; x++) {
        const p = px[(y * w + x) * 2];
        const a = p >>> 24;
        let r = (p >>> 16) & 255;
        let g = (p >>> 8) & 255;
        let b = p & 255;
        if (a) {
          r = Math.min(255, Math.floor((r * 255) / a));
          g = Math.min(255, Math.floor((g * 255) / a));
          b = Math.min(255, Math.floor((b * 255) / a));
        }
        raw[o++] = r;
        raw[o++] = g;
        raw[o++] = b;
        raw[o++] = a;
      }
    }
    out({ t: "cursor", png: png(w, h, raw).toString("base64"), x: dv.getUint16(8, true), y: dv.getUint16(10, true) });
  }
  X.XFree(img);
}

// --- the pixels: the rectangles that changed, read off the display as they change -----

let pixelsOn = false;
let damage = 0;
let damageBase = -1;
// damaged since the last flush: x, y, w, h on the display
let dirty = [];
let dirtyAt = 0;
let lastFlush = 0;
let flushTimer = null;
// while video streams instead: how much changes, told twice a second as pixels damaged
let motionOn = false;
let motionPx = 0;
let motionAt = 0;
let saidDepth = false;

// one rectangle of the view, read and sent: its header a JSON line, its pixels after
function sendRect(x, y, w, h) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(vw, x + w);
  const y1 = Math.min(vh, y + h);
  if (x1 <= x0 || y1 <= y0) return;
  const img = X.XGetImage(dpy, root, x0, y0, x1 - x0, y1 - y0, 0xffffffff, 2);
  if (!img) return;
  let raw;
  let rw;
  let rh;
  let order;
  try {
    const dv = new DataView(toArrayBuffer(img, 0, 56));
    if (dv.getInt32(48, true) !== 32) {
      if (!saidDepth) {
        saidDepth = true;
        out({ t: "log", s: "the display isn't 32 bits a pixel; no pixels sent" });
      }
      return;
    }
    rw = dv.getInt32(0, true);
    rh = dv.getInt32(4, true);
    order = dv.getInt32(24, true);
    const bpl = dv.getInt32(44, true);
    const all = new Uint8Array(toArrayBuffer(u64(dv, 16), 0, bpl * rh));
    if (bpl === rw * 4) raw = all.slice();
    else {
      raw = new Uint8Array(rw * 4 * rh);
      for (let r = 0; r < rh; r++) raw.set(all.subarray(r * bpl, r * bpl + rw * 4), r * rw * 4);
    }
  } finally {
    X.XDestroyImage(img);
  }
  const z = deflateSync(raw, { level: 1 });
  const head = enc.encode(
    `${JSON.stringify({ t: "rect", x: x0, y: y0, w: rw, h: rh, n: z.length, z: 1, o: order })}\n`,
  );
  const b = new Uint8Array(head.length + z.length);
  b.set(head);
  b.set(z, head.length);
  write(b);
}

function flushRects() {
  const rs = mergeRects(dirty);
  dirty = [];
  dirtyAt = 0;
  lastFlush = performance.now();
  if (damage) Xd.XDamageSubtract(dpy, damage, 0, 0);
  if (pixelsOn) for (const r of rs) sendRect(...r);
}

// the read waits out the gather and the gap
function scheduleFlush() {
  if (flushTimer || !dirty.length) return;
  const now = performance.now();
  const wait = Math.max(0, GATHER - (now - dirtyAt), FLUSH_GAP - (now - lastFlush));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty.length) return;
    flushRects();
    onX();
  }, wait);
}

// the whole view again: a viewer that comes or fell behind, a resize
function refresh() {
  if (!pixelsOn) return;
  dirty = [];
  dirtyAt = 0;
  if (damage) Xd.XDamageSubtract(dpy, damage, 0, 0);
  out({ t: "size", w: vw, h: vh });
  sendRect(0, 0, vw, vh);
}

// XDamage on the whole display, once: raw rectangles, each change as drawn, merged here
function wantDamage() {
  if (damage || !Xd) return !!damage;
  const a = new Int32Array(1);
  const b = new Int32Array(1);
  if (Xd.XDamageQueryExtension(dpy, a, b)) {
    damageBase = a[0];
    damage = Xd.XDamageCreate(dpy, root, 0);
  }
  return !!damage;
}

function setPixels(on) {
  pixelsOn = !!on && wantDamage();
  dirty = [];
  if (pixelsOn) refresh();
  else if (damage) Xd.XDamageSubtract(dpy, damage, 0, 0);
}

function setMotion(on) {
  motionOn = !!on && wantDamage();
  motionPx = 0;
  motionAt = performance.now();
}

function flushMotion() {
  motionAt = performance.now();
  out({ t: "motion", px: motionPx });
  motionPx = 0;
  if (damage && !pixelsOn) Xd.XDamageSubtract(dpy, damage, 0, 0);
}

// --- the clipboard -------------------------------------------------------------------

let clipwin = 0;
let clipText = Buffer.alloc(0);
let fixesBase = -1;

function ownClipboard(text) {
  clipText = Buffer.from(text, "utf8").subarray(0, 1 << 20);
  for (const sel of ["CLIPBOARD", "PRIMARY"]) X.XSetSelectionOwner(dpy, atom(sel), clipwin, 0);
}

function answerRequest() {
  const requestor = u64(ed, 40);
  const selection = u64(ed, 48);
  const target = u64(ed, 56);
  const p = u64(ed, 64) || target;
  const time = u64(ed, 72);
  const utf8 = atom("UTF8_STRING");
  const targets = atom("TARGETS");
  let ok = true;
  if (target === targets) {
    const arr = new BigUint64Array([targets, utf8, atom("STRING"), atom("TEXT")].map(BigInt));
    X.XChangeProperty(dpy, requestor, p, atom("ATOM"), 32, 0, arr, 4);
  } else if ([utf8, atom("STRING"), atom("TEXT"), atom("text/plain;charset=utf-8")].includes(target)) {
    const type = target === atom("STRING") ? atom("STRING") : utf8;
    X.XChangeProperty(dpy, requestor, p, type, 8, 0, clipText.length ? clipText : new Uint8Array(1), clipText.length);
  } else ok = false;
  const [b, dv] = event();
  dv.setInt32(0, SelectionNotify, true);
  setU64(dv, 32, requestor);
  setU64(dv, 40, selection);
  setU64(dv, 48, target);
  setU64(dv, 56, ok ? p : 0);
  setU64(dv, 64, time);
  X.XSendEvent(dpy, requestor, 0, 0, b);
}

function hostCopied() {
  const owner = u64(ed, 48);
  if (owner && owner !== clipwin)
    X.XConvertSelection(dpy, atom("CLIPBOARD"), atom("UTF8_STRING"), atom("PHOS_CLIP"), clipwin, 0);
}

function gotSelection() {
  const requestor = u64(ed, 32);
  const property = u64(ed, 56);
  if (requestor !== clipwin || !property) return;
  const [, , raw] = prop(clipwin, property, 0, 1 << 20);
  X.XDeleteProperty(dpy, clipwin, property);
  if (raw.length) out({ t: "clip", s: Buffer.from(raw).toString("utf8") });
}

// --- input from the viewer ----------------------------------------------------------

const int = (v) => Math.trunc(Number(v)) || 0;

function onLine(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (!Array.isArray(m) || !m.length) return;
  const k = m[0];
  if (k === "m" && Xt)
    Xt.XTestFakeMotionEvent(
      dpy,
      -1,
      Math.max(0, Math.min(int(m[1]), vw - 1)),
      Math.max(0, Math.min(int(m[2]), vh - 1)),
      0,
    );
  else if (k === "b") button(int(m[1]), !!m[2]);
  else if (k === "w") wheel(int(m[1]), int(m[2]));
  else if (k === "k") key(!!m[1], int(m[2]), int(m[3]), String(m.length > 4 ? m[4] : m[2]));
  else if (k === "x") typeText(String(m[1]));
  else if (k === "r") resizeView(int(m[1]), int(m[2]));
  else if (k === "raise") {
    const w = int(m[1]);
    if (wins.includes(w)) {
      focus(w);
      report();
    }
  } else if (k === "clip") ownClipboard(String(m[1]));
  else if (k === "pixels") setPixels(m.length > 1 ? m[1] : true);
  else if (k === "refresh") refresh();
  else if (k === "motion") setMotion(m.length > 1 ? m[1] : true);
  else if (k === "close") closeMain();
  else if (k === "quit") shutdown(0);
  X.XFlush(dpy);
}

function onX() {
  while (X.XPending(dpy)) {
    X.XNextEvent(dpy, ev);
    const t = ed.getInt32(0, true);
    if (t === MapRequest) manage(u64(ed, 40));
    else if (t === ConfigureRequest) {
      const w = u64(ed, 40);
      const mask = u64(ed, 88);
      const [rx, ry, rw, rh] = [48, 52, 56, 60].map((o) => ed.getInt32(o, true));
      if (wins.includes(w)) {
        if (full.has(w)) syntheticConfigure(w);
        else {
          const [x, y] = geo.get(w) ?? [0, 0];
          place(w, mask & CWWidth ? rw : null, mask & CWHeight ? rh : null, mask & CWX ? rx : x, mask & CWY ? ry : y);
        }
      } else {
        const c = new Uint8Array(40);
        const dv = new DataView(c.buffer);
        dv.setInt32(0, rx, true);
        dv.setInt32(4, ry, true);
        dv.setInt32(8, rw, true);
        dv.setInt32(12, rh, true);
        dv.setInt32(16, ed.getInt32(64, true), true);
        setU64(dv, 24, u64(ed, 72));
        dv.setInt32(32, ed.getInt32(80, true), true);
        X.XConfigureWindow(dpy, w, mask & 0x7f, c);
      }
    } else if (t === UnmapNotify || t === DestroyNotify) unmanage(u64(ed, 40));
    else if (t === PropertyNotify) {
      const w = u64(ed, 32);
      const n = atomName(u64(ed, 40));
      if (wins.includes(w) && (n === "_NET_WM_NAME" || n === "WM_NAME")) report();
    } else if (t === SelectionRequest) answerRequest();
    else if (t === SelectionNotify) gotSelection();
    else if (t === MappingNotify) loadKeymap();
    else if (fixesBase >= 0 && t === fixesBase + 1) cursorChanged();
    else if (fixesBase >= 0 && t === fixesBase) hostCopied();
    else if (damageBase >= 0 && t === damageBase) {
      const [x, y, w, h] = [
        ed.getInt16(64, true),
        ed.getInt16(66, true),
        ed.getUint16(68, true),
        ed.getUint16(70, true),
      ];
      if (pixelsOn) {
        dirty.push([x, y, w, h]);
        dirtyAt ||= performance.now();
      } else if (motionOn) motionPx += w * h;
    }
  }
  X.XFlush(dpy);
  scheduleFlush();
}

// --- the app ---------------------------------------------------------------------------

function launch(argv, display, scale, dbus) {
  const env = { ...process.env };
  for (const k of ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DESKTOP_STARTUP_ID", "XDG_ACTIVATION_TOKEN", "BUN_BE_BUN"])
    delete env[k];
  Object.assign(env, {
    DISPLAY: display,
    XDG_SESSION_TYPE: "x11",
    GDK_BACKEND: "x11",
    QT_QPA_PLATFORM: "xcb",
    SDL_VIDEODRIVER: "x11",
    MOZ_ENABLE_WAYLAND: "0",
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
    NO_AT_BRIDGE: "1",
    _JAVA_AWT_WM_NONREPARENTING: "1",
  });
  if (scale >= 1.5) {
    env.GDK_SCALE = String(Math.round(scale));
    env.QT_SCALE_FACTOR = String(Math.round(scale * 100) / 100);
  }
  if (!Bun.which(argv[0]) && !existsSync(argv[0])) fail(`${argv[0]} isn't on this host's PATH`);
  // its own session bus: a single-instance app starts here rather than handing its
  // window to a copy already open on the host's own screen
  if (dbus && Bun.which("dbus-run-session")) {
    delete env.DBUS_SESSION_BUS_ADDRESS;
    argv = ["dbus-run-session", "--", ...argv];
  }
  try {
    proc = spawn(argv[0], argv.slice(1), { env, cwd: homedir(), stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (e) {
    fail(`couldn't start ${argv[0]}: ${e?.message ?? e}`);
  }
  proc.on("error", (e) => fail(`couldn't start ${argv[0]}: ${e?.message ?? e}`));
  const keep = (d) => {
    applog = Buffer.concat([applog, d]).subarray(-16000);
  };
  proc.stdout.on("data", keep);
  proc.stderr.on("data", keep);
  proc.on("exit", (code, sig) => {
    procExit = code ?? -(osc.signals[sig] ?? 1);
    tick();
  });
}

let seenWindow = false;
let goneAt = 0;

function tick() {
  onX();
  if (motionOn && !pixelsOn && performance.now() - motionAt >= MOTION_EVERY) flushMotion();
  if (wins.length) [seenWindow, goneAt] = [true, 0];
  if (procExit !== null && !wins.length) {
    // a launcher that exits after handing off waits a moment for its window
    goneAt ||= performance.now();
    if (seenWindow || performance.now() - goneAt > 3000) {
      out({
        t: "exit",
        code: procExit,
        log: logText(4000),
        error: seenWindow
          ? ""
          : "it exited before opening a window; an app open already (on the host's screen, or streamed) may have taken the window itself",
      });
      shutdown(0);
    }
  }
  if (xvfb.exitCode !== null) fail("the X server stopped");
}

async function start(cfg, rest) {
  const argv = (cfg.argv ?? []).map(String);
  if (!argv.length) fail("nothing to run");
  C = lib("c", csyms);
  X = lib("X11", xsyms);
  if (!X) fail("libX11 isn't on this host");
  Xt = lib("Xtst", tsyms);
  Xf = lib("Xfixes", fsyms);
  Xd = lib("Xdamage", dsyms);
  if (!Xt) out({ t: "log", s: "libXtst isn't on this host: view only" });
  sw = int(cfg.sw ?? 1920);
  sh = int(cfg.sh ?? 1080);
  const [n, auth, d] = await startXvfb(int(cfg.dpi ?? 96));
  dpy = d;
  // a window gone between the event and the call is the normal case for a WM; the
  // default handler would exit the process over it
  errh = new JSCallback(() => 0, { args: [P, P], returns: I });
  X.XSetErrorHandler(errh.ptr);
  root = X.XDefaultRootWindow(dpy);
  X.XSelectInput(dpy, root, SubstructureRedirect | SubstructureNotify);
  clipwin = X.XCreateSimpleWindow(dpy, root, -10, -10, 1, 1, 0, 0, 0);
  const a = new Int32Array(1);
  const b = new Int32Array(1);
  if (Xf?.XFixesQueryExtension(dpy, a, b)) {
    fixesBase = a[0];
    Xf.XFixesSelectCursorInput(dpy, root, 1);
    Xf.XFixesSelectSelectionInput(dpy, root, atom("CLIPBOARD"), 1);
  }
  loadKeymap();
  resizeView(int(cfg.w ?? 1280), int(cfg.h ?? 720));
  X.XSync(dpy, 0);
  launch(argv, `:${n}`, Number(cfg.scale ?? 1), cfg.dbus ?? true);
  out({ t: "ready", display: `:${n}`, auth, w: vw, h: vh, xtest: !!Xt, pixels: !!Xd });
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const poller = new Worker(URL.createObjectURL(new Blob([POLLER], { type: "application/javascript" })));
  poller.onmessage = (e) => {
    if (e.data === 1) fail("the X server stopped");
    onX();
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
  };
  poller.postMessage({ fd: X.XConnectionNumber(dpy), sab: gate.buffer });
  for (const l of rest) onLine(l);
  onX();
  setInterval(tick, TICK);
}

async function main() {
  for (const s of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(s, () => shutdown(0));
  const crash = (e) => {
    out({ t: "exit", code: -1, error: `agent: ${e?.message ?? e}`, log: String(e?.stack ?? "").slice(-3000) });
    shutdown(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  let buf = "";
  let started = false;
  const early = [];
  const dec = new TextDecoder();
  for await (const c of Bun.stdin.stream()) {
    buf += dec.decode(c, { stream: true });
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (!line.trim()) continue;
      if (!started) {
        started = true;
        start(JSON.parse(line), early)
          .then(() => (started = "up"))
          .catch(crash);
      } else if (started !== "up") early.push(line);
      else onLine(line);
    }
    if (started === "up") onX();
  }
  shutdown(0);
}

if (import.meta.main) void main();
