// the Windows notification-area icon and its menu over user32/shell32: a hidden
// window owning the icon, its messages pumped on a timer beside the event loop
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";
import { wstr, type Tray, type TrayItem } from "./tray.ts";

const { u32, i32, u64, ptr: P, bool, i64 } = FFIType;

const user32 = dlopen("user32.dll", {
  RegisterClassExW: { args: [P], returns: u32 },
  CreateWindowExW: { args: [u32, P, P, u32, i32, i32, i32, i32, u64, u64, u64, u64], returns: u64 },
  DefWindowProcW: { args: [u64, u32, u64, i64], returns: i64 },
  PeekMessageW: { args: [P, u64, u32, u32, u32], returns: bool },
  TranslateMessage: { args: [P], returns: bool },
  DispatchMessageW: { args: [P], returns: i64 },
  CreatePopupMenu: { args: [], returns: u64 },
  DestroyMenu: { args: [u64], returns: bool },
  AppendMenuW: { args: [u64, u32, u64, P], returns: bool },
  TrackPopupMenu: { args: [u64, u32, i32, i32, i32, u64, u64], returns: i32 },
  GetCursorPos: { args: [P], returns: bool },
  SetForegroundWindow: { args: [u64], returns: bool },
  PostMessageW: { args: [u64, u32, u64, i64], returns: bool },
  RegisterWindowMessageW: { args: [P], returns: u32 },
  LoadImageW: { args: [u64, P, u32, i32, i32, u32], returns: u64 },
  DestroyIcon: { args: [u64], returns: bool },
  DestroyWindow: { args: [u64], returns: bool },
});
const shell32 = dlopen("shell32.dll", { Shell_NotifyIconW: { args: [u32, P], returns: bool } });
const kernel32 = dlopen("kernel32.dll", { GetModuleHandleW: { args: [u64], returns: u64 } });
const U = user32.symbols;

const WM_COMMAND = 0x111, WM_APP = 0x8000, WM_LBUTTONUP = 0x202, WM_RBUTTONUP = 0x205, WM_CONTEXTMENU = 0x7b;
const NIM_ADD = 0, NIM_MODIFY = 1, NIM_DELETE = 2, NIF_MESSAGE = 1, NIF_ICON = 2, NIF_TIP = 4;
const MF_STRING = 0, MF_GRAYED = 1, MF_SEPARATOR = 0x800, TPM_RETURNCMD = 0x100, TPM_NONOTIFY = 0x80, TPM_RIGHTBUTTON = 2;
const CALLBACK = WM_APP + 1;

export function win32Tray(icon: Uint8Array, tooltip: string): Tray {
  const hinst = kernel32.symbols.GetModuleHandleW(0n);
  const className = wstr("PhosphorusTray");
  let items: TrayItem[] = [];
  const taskbarCreated = U.RegisterWindowMessageW(wstr("TaskbarCreated"));

  const wndProc = new JSCallback(
    (hwnd: bigint, msg: number, wp: bigint, lp: bigint): bigint => {
      if (msg === CALLBACK) {
        const ev = Number(lp & 0xffffn);
        if (ev === WM_RBUTTONUP || ev === WM_CONTEXTMENU || ev === WM_LBUTTONUP) popup();
        return 0n;
      }
      // Explorer restarted: the icon put back
      if (msg === taskbarCreated && taskbarCreated) notify(NIM_ADD);
      return U.DefWindowProcW(hwnd, msg, wp, lp) as bigint;
    },
    { args: [u64, u32, u64, i64], returns: i64 },
  );

  const wc = Buffer.alloc(80);
  wc.writeUInt32LE(80, 0);
  wc.writeBigUInt64LE(BigInt(wndProc.ptr as number), 8);
  wc.writeBigUInt64LE(hinst as bigint, 24);
  wc.writeBigUInt64LE(BigInt(ptr(className)), 64);
  U.RegisterClassExW(wc);
  // a plain hidden window, not a message-only one: menus need a foreground owner
  const hwnd = U.CreateWindowExW(0, className, className, 0, 0, 0, 0, 0, 0n, 0n, hinst, 0n) as bigint;
  if (!hwnd) throw new Error("tray: CreateWindowExW failed");

  // the .ico's bytes by way of a file: LoadImageW reads no memory
  let hicon = 0n;
  const loadIcon = (ico: Uint8Array) => {
    const p = join(tmpdir(), `phosphorus-tray-${process.pid}.ico`);
    writeFileSync(p, ico);
    const h = U.LoadImageW(0n, wstr(p), 1 /* IMAGE_ICON */, 0, 0, 0x10 | 0x40 /* LR_LOADFROMFILE|LR_DEFAULTSIZE */) as bigint;
    if (h) {
      if (hicon) U.DestroyIcon(hicon);
      hicon = h;
    }
  };
  loadIcon(icon);

  // NOTIFYICONDATAW, x64 layout
  const nid = Buffer.alloc(976);
  nid.writeUInt32LE(976, 0);
  nid.writeBigUInt64LE(hwnd, 8);
  nid.writeUInt32LE(1, 16);
  nid.writeUInt32LE(NIF_MESSAGE | NIF_ICON | NIF_TIP, 20);
  nid.writeUInt32LE(CALLBACK, 24);
  const setTipText = (t: string) => {
    nid.fill(0, 40, 40 + 256);
    nid.write(t.slice(0, 127), 40, "utf16le");
  };
  setTipText(tooltip);
  const notify = (op: number) => {
    nid.writeBigUInt64LE(hicon, 32);
    return shell32.symbols.Shell_NotifyIconW(op, nid);
  };
  if (!notify(NIM_ADD)) throw new Error("tray: Shell_NotifyIconW failed");

  function popup() {
    const menu = U.CreatePopupMenu() as bigint;
    const keep: Buffer[] = [];
    items.forEach((it, i) => {
      if (it.separator) return void U.AppendMenuW(menu, MF_SEPARATOR, 0n, null);
      const label = wstr(it.label ?? "");
      keep.push(label);
      U.AppendMenuW(menu, MF_STRING | (it.enabled === false ? MF_GRAYED : 0), BigInt(i + 1), label);
    });
    const pt = Buffer.alloc(8);
    U.GetCursorPos(pt);
    U.SetForegroundWindow(hwnd);
    const cmd = U.TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON, pt.readInt32LE(0), pt.readInt32LE(4), 0, hwnd, 0n);
    U.PostMessageW(hwnd, 0, 0n, 0n);
    U.DestroyMenu(menu);
    // run after the menu's own loop has unwound
    const it = cmd > 0 ? items[cmd - 1] : undefined;
    if (it?.onClick) setTimeout(it.onClick, 0);
  }

  // this thread's messages, the event loop's timers interleaved with them
  const msg = Buffer.alloc(48);
  const tick = () => {
    while (U.PeekMessageW(msg, 0n, 0, 0, 1 /* PM_REMOVE */)) {
      U.TranslateMessage(msg);
      U.DispatchMessageW(msg);
    }
  };
  let pump: ReturnType<typeof setInterval> | undefined;

  return {
    setMenu(next) { items = next; },
    setTooltip(t) { setTipText(t); notify(NIM_MODIFY); },
    setIcon(ico) { loadIcon(ico); notify(NIM_MODIFY); },
    run() { pump ??= setInterval(tick, 30); },
    // tests and diagnostics: the menu as if clicked
    _popup: popup,
    _hwnd: hwnd,
    _post: (lp: number) => U.PostMessageW(hwnd, CALLBACK, 1n, BigInt(lp)),
    quit() {
      if (pump) clearInterval(pump);
      pump = undefined;
      notify(NIM_DELETE);
      if (hicon) U.DestroyIcon(hicon);
      U.DestroyWindow(hwnd);
      wndProc.close();
    },
  } as Tray;
}
