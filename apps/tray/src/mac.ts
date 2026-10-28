// the macOS menu bar item and its menu over the Objective-C runtime alone: AppKit's
// NSStatusItem with a template NSImage from PNG bytes and an NSMenu whose items
// target one runtime-made class, NSApplication's events pumped on a timer beside
// the event loop. objc_msgSend is called through fixed prototypes, one per
// argument shape, never as a variadic
import { dlopen, FFIType, JSCallback, type FFITypeOrString, type Pointer } from "bun:ffi";
import { cstr, type Tray, type TrayItem } from "./tray.ts";

const LIBOBJC = "/usr/lib/libobjc.A.dylib";
const { ptr: P, bool, i64, u64, double } = FFIType;

// an id, Class or SEL as the ffi hands them back; nil as null or 0
type id = Pointer | bigint | null;

const objc = dlopen(LIBOBJC, {
  objc_getClass: { args: [P], returns: P },
  sel_registerName: { args: [P], returns: P },
  objc_allocateClassPair: { args: [P, P, u64], returns: P },
  objc_registerClassPair: { args: [P], returns: FFIType.void },
  class_addMethod: { args: [P, P, P, P], returns: bool },
}).symbols;

// AppKit loaded (Foundation with it) so its classes resolve; NSApplicationLoad also
// readies the app's connection to the window server
const appkit = dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", {
  NSApplicationLoad: { args: [], returns: bool },
}).symbols;

// objc_msgSend under one fixed prototype: (self, SEL, ...args) -> returns
const sender = <const A extends readonly FFITypeOrString[], const R extends FFITypeOrString>(args: A, returns: R) =>
  dlopen(LIBOBJC, { objc_msgSend: { args, returns } }).symbols.objc_msgSend;

// receiver and selector first in each
const send = {
  v: sender([P, P], P),
  o: sender([P, P, P], P),
  ooo: sender([P, P, P, P, P], P),
  b: sender([P, P, bool], P),
  i: sender([P, P, i64], P),
  d: sender([P, P, double], P),
  // an NSSize by value: two doubles, in registers on x86_64 (xmm0, xmm1) and arm64 (d0, d1) alike
  size: sender([P, P, double, double], P),
  bytes: sender([P, P, P, u64], P),
  event: sender([P, P, u64, P, P, bool], P),
  tag: sender([P, P], i64),
};

const cls = (name: string): id => {
  const c = objc.objc_getClass(cstr(name));
  if (!c) throw new Error(`tray: no Objective-C class ${name}`);
  return c;
};
const sels = new Map<string, id>();
const sel = (name: string): id => {
  let s = sels.get(name);
  if (!s) sels.set(name, (s = objc.sel_registerName(cstr(name))));
  return s;
};
const nsstr = (s: string): id => send.o(cls("NSString"), sel("stringWithUTF8String:"), cstr(s));
const alloc = (name: string): id => send.v(cls(name), sel("alloc"));
const release = (o: id) => void (o && send.v(o, sel("release")));

// f under an autorelease pool of its own, the pool drained after: what AppKit
// autoreleases in a tick or a menu rebuild freed then, not never
function pooled<T>(f: () => T): T {
  const pool = send.v(alloc("NSAutoreleasePool"), sel("init"));
  try {
    return f();
  } finally {
    send.v(pool, sel("drain"));
  }
}

const NSApplicationActivationPolicyAccessory = 1n;
const NSVariableStatusItemLength = -1;
const NSEventMaskAny = 0xffffffffffffffffn;
// NSDefaultRunLoopMode's value
const DefaultRunLoopMode = "kCFRunLoopDefaultMode";
// the menu bar's icon size in points, as fyne's systray sizes it
const IconSize = 16;

export function macTray(icon: Uint8Array, tooltip: string): Tray {
  appkit.NSApplicationLoad();
  let items: TrayItem[] = [];

  // the menu items' target: an NSObject subclass with trayClick:, made here once
  const onClick = new JSCallback(
    (_self: Pointer, _cmd: Pointer, sender: Pointer) => {
      const it = items[Number(send.tag(sender, sel("tag")))];
      // run after the menu's own tracking loop has unwound
      if (it?.onClick) setTimeout(it.onClick, 0);
    },
    { args: [P, P, P], returns: FFIType.void },
  );
  const targetClass = objc.objc_allocateClassPair(cls("NSObject"), cstr("PhosphorusTrayTarget"), 0n);
  if (!targetClass) throw new Error("tray: objc_allocateClassPair failed");
  objc.class_addMethod(targetClass, sel("trayClick:"), onClick.ptr, cstr("v@:@"));
  objc.objc_registerClassPair(targetClass);
  const target = send.v(send.v(targetClass, sel("alloc")), sel("init"));

  // the app itself, in the menu bar alone, launched by hand rather than by [NSApp run]
  const app = send.v(cls("NSApplication"), sel("sharedApplication"));
  send.i(app, sel("setActivationPolicy:"), NSApplicationActivationPolicyAccessory);
  send.v(app, sel("finishLaunching"));

  const bar = send.v(cls("NSStatusBar"), sel("systemStatusBar"));
  const item = send.v(send.d(bar, sel("statusItemWithLength:"), NSVariableStatusItemLength), sel("retain"));
  const button = send.v(item, sel("button"));
  if (!button) throw new Error("tray: the status item has no button");
  const distantPast = send.v(send.v(cls("NSDate"), sel("distantPast")), sel("retain"));
  const defaultMode = send.v(nsstr(DefaultRunLoopMode), sel("retain"));

  let image: id = null;
  const setIcon = (png: Uint8Array) =>
    pooled(() => {
      const data = send.bytes(cls("NSData"), sel("dataWithBytes:length:"), png, BigInt(png.byteLength));
      const img = send.o(alloc("NSImage"), sel("initWithData:"), data);
      if (!img) throw new Error("tray: NSImage couldn't read the icon");
      send.size(img, sel("setSize:"), IconSize, IconSize);
      // the glyph tinted like the system's own, light or dark menu bar
      send.b(img, sel("setTemplate:"), true);
      send.o(button, sel("setImage:"), img);
      release(image);
      image = img;
    });
  const setTooltip = (t: string) => pooled(() => void send.o(button, sel("setToolTip:"), nsstr(t)));

  let menu: id = null;
  const setMenu = (next: TrayItem[]) =>
    pooled(() => {
      items = next;
      const m = send.o(alloc("NSMenu"), sel("initWithTitle:"), nsstr(""));
      // enabled as set here, not as AppKit would validate each item's action
      send.b(m, sel("setAutoenablesItems:"), false);
      next.forEach((it, i) => {
        if (it.separator) return void send.o(m, sel("addItem:"), send.v(cls("NSMenuItem"), sel("separatorItem")));
        const mi = send.ooo(alloc("NSMenuItem"), sel("initWithTitle:action:keyEquivalent:"), nsstr(it.label ?? ""), sel("trayClick:"), nsstr(""));
        send.o(mi, sel("setTarget:"), target);
        send.i(mi, sel("setTag:"), BigInt(i));
        send.b(mi, sel("setEnabled:"), it.enabled !== false);
        send.o(m, sel("addItem:"), mi);
        release(mi);
      });
      send.o(item, sel("setMenu:"), m);
      release(menu);
      menu = m;
    });

  setIcon(icon);
  setTooltip(tooltip);

  // the app's queued events dispatched, as [NSApp run] would, then back to the
  // event loop; a click's menu tracks inside sendEvent: until it closes
  const tick = () =>
    pooled(() => {
      for (;;) {
        const ev = send.event(app, sel("nextEventMatchingMask:untilDate:inMode:dequeue:"), NSEventMaskAny, distantPast, defaultMode, true);
        if (!ev) break;
        send.o(app, sel("sendEvent:"), ev);
      }
      send.v(app, sel("updateWindows"));
    });
  let pump: ReturnType<typeof setInterval> | undefined;

  return {
    setIcon,
    setTooltip,
    setMenu,
    run() {
      pump ??= setInterval(tick, 30);
    },
    quit() {
      if (pump) clearInterval(pump);
      pump = undefined;
      pooled(() => {
        send.o(bar, sel("removeStatusItem:"), item);
        release(item);
        release(menu);
        release(image);
      });
      // the target class stays registered: AppKit may still hold the items
    },
  };
}
