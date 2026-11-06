# appstream's host half: one GUI app on its own headless X server, run as the
# viewer's login over ssh. It starts Xvfb with a fresh cookie, is that display's
# window manager (the app's main window fills the viewer's window, dialogs centred
# over it), types and clicks what the viewer does through XTEST, and reports the
# title, the windows, the pointer's shape and the clipboard. The pixels too, as
# the rectangles that changed (XDamage), each read off the display and deflated,
# the moment they change: no video, no frame clock. ffmpeg grabs this display
# instead when the viewer wants video.
#
# stdin and stdout are JSON, one message a line. The first line in is the start:
#   {"argv": [...], "w", "h", "sw", "sh", "dpi", "scale", "dbus": bool}
# then arrays: ["m",x,y] ["b",n,down] ["w",dx,dy] ["k",down,keycode,keysym]
# ["x",text] ["r",w,h] ["raise",id] ["clip",text] ["close"] ["quit"]
# ["pixels",on] ["refresh"] ["motion",on]
# Out: {"t":"ready"|"title"|"windows"|"cursor"|"clip"|"exit"|"log"|"size"|"motion", ...}
# and {"t":"rect","x","y","w","h","n","z","o"} followed by n bytes: the pixels,
# 32 bits each, deflated when z
# Python 3.6 and its standard library, nothing else; libX11, libXtst, libXfixes,
# libXdamage for the pixels.

import base64, ctypes, ctypes.util, json, os, random, re, select, shutil, signal, struct, subprocess, sys, tempfile, time, zlib
from ctypes import POINTER, Structure, Union, byref, c_char_p, c_int, c_long, c_short, c_uint, c_ubyte, c_ulong, c_ushort, c_void_p

def out(**m):
    try:
        os.write(1, (json.dumps(m, separators=(",", ":")) + "\n").encode())
    except OSError:
        shutdown(0)

def lib(name):
    p = ctypes.util.find_library(name)
    for cand in ([p] if p else []) + ["lib%s.so.6" % name, "lib%s.so.3" % name, "lib%s.so" % name]:
        try:
            return ctypes.CDLL(cand)
        except OSError:
            pass
    return None

Window = Atom = Time = KeySym = c_ulong
Display = c_void_p

class XAnyEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", Display), ("window", Window)]

class XMapRequestEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", Display),
                ("parent", Window), ("window", Window)]

class XConfigureRequestEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", Display),
                ("parent", Window), ("window", Window), ("x", c_int), ("y", c_int), ("width", c_int),
                ("height", c_int), ("border_width", c_int), ("above", Window), ("detail", c_int),
                ("value_mask", c_ulong)]

class XConfigureEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", Display),
                ("event", Window), ("window", Window), ("x", c_int), ("y", c_int), ("width", c_int),
                ("height", c_int), ("border_width", c_int), ("above", Window), ("override_redirect", c_int)]

class XUnmapEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", Display),
                ("event", Window), ("window", Window), ("from_configure", c_int)]

class XPropertyEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", Display),
                ("window", Window), ("atom", Atom), ("time", Time), ("state", c_int)]

class XClientMessageEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", Display),
                ("window", Window), ("message_type", Atom), ("format", c_int), ("l", c_long * 5)]

class XSelectionRequestEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", Display),
                ("owner", Window), ("requestor", Window), ("selection", Atom), ("target", Atom),
                ("property", Atom), ("time", Time)]

class XSelectionEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", Display),
                ("requestor", Window), ("selection", Atom), ("target", Atom), ("property", Atom), ("time", Time)]

class XFixesSelectionNotifyEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", Display),
                ("window", Window), ("subtype", c_int), ("owner", Window), ("selection", Atom),
                ("timestamp", Time), ("selection_timestamp", Time)]

class XRectangle(Structure):
    _fields_ = [("x", c_short), ("y", c_short), ("width", c_ushort), ("height", c_ushort)]

class XDamageNotifyEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", Display),
                ("drawable", Window), ("damage", c_ulong), ("level", c_int), ("more", c_int),
                ("timestamp", Time), ("area", XRectangle), ("geometry", XRectangle)]

class XEvent(Union):
    _fields_ = [("type", c_int), ("any", XAnyEvent), ("pad", c_long * 24)]

class XImage(Structure):
    pass

class XImageFuncs(Structure):
    _fields_ = [("create_image", c_void_p), ("destroy_image", ctypes.CFUNCTYPE(c_int, POINTER(XImage))),
                ("get_pixel", c_void_p), ("put_pixel", c_void_p), ("sub_image", c_void_p), ("add_pixel", c_void_p)]

XImage._fields_ = [("width", c_int), ("height", c_int), ("xoffset", c_int), ("format", c_int), ("data", c_void_p),
                   ("byte_order", c_int), ("bitmap_unit", c_int), ("bitmap_bit_order", c_int), ("bitmap_pad", c_int),
                   ("depth", c_int), ("bytes_per_line", c_int), ("bits_per_pixel", c_int), ("red_mask", c_ulong),
                   ("green_mask", c_ulong), ("blue_mask", c_ulong), ("obdata", c_void_p), ("f", XImageFuncs)]

class XWindowAttributes(Structure):
    _fields_ = [("x", c_int), ("y", c_int), ("width", c_int), ("height", c_int), ("border_width", c_int),
                ("depth", c_int), ("visual", c_void_p), ("root", Window), ("class_", c_int),
                ("bit_gravity", c_int), ("win_gravity", c_int), ("backing_store", c_int),
                ("backing_planes", c_ulong), ("backing_pixel", c_ulong), ("save_under", c_int),
                ("colormap", c_ulong), ("map_installed", c_int), ("map_state", c_int),
                ("all_event_masks", c_long), ("your_event_mask", c_long), ("do_not_propagate_mask", c_long),
                ("override_redirect", c_int), ("screen", c_void_p)]

class XWindowChanges(Structure):
    _fields_ = [("x", c_int), ("y", c_int), ("width", c_int), ("height", c_int), ("border_width", c_int),
                ("sibling", Window), ("stack_mode", c_int)]

class XFixesCursorImage(Structure):
    _fields_ = [("x", c_short), ("y", c_short), ("width", c_ushort), ("height", c_ushort), ("xhot", c_ushort),
                ("yhot", c_ushort), ("cursor_serial", c_ulong), ("pixels", POINTER(c_ulong)), ("atom", Atom),
                ("name", c_char_p)]

KeyPress, ButtonPress = 2, 4
DestroyNotify, UnmapNotify, MapRequest, ConfigureNotify, ConfigureRequest = 17, 18, 20, 22, 23
PropertyNotify, SelectionClear, SelectionRequest, SelectionNotify, ClientMessage = 28, 29, 30, 31, 33
SubstructureRedirect, SubstructureNotify, StructureNotify, PropertyChange = 1 << 20, 1 << 19, 1 << 17, 1 << 22
CWX, CWY, CWWidth, CWHeight = 1, 2, 4, 8

X = Xt = Xf = Xd = None
dpy = None
root = 0
proc = None
xvfb = None
tmpdir = ""
applog = b""

def setup_libs():
    global X, Xt, Xf, Xd
    X, Xt, Xf, Xd = lib("X11"), lib("Xtst"), lib("Xfixes"), lib("Xdamage")
    if not X:
        fail("libX11 isn't on this host")
    X.XGetImage.restype = POINTER(XImage)
    X.XGetImage.argtypes = [Display, Window, c_int, c_int, c_uint, c_uint, c_ulong, c_int]
    X.XOpenDisplay.restype = Display
    X.XOpenDisplay.argtypes = [c_char_p]
    X.XDefaultRootWindow.restype = Window
    X.XDefaultRootWindow.argtypes = [Display]
    X.XConnectionNumber.argtypes = [Display]
    X.XInternAtom.restype = Atom
    X.XInternAtom.argtypes = [Display, c_char_p, c_int]
    X.XGetAtomName.restype = c_void_p
    X.XGetAtomName.argtypes = [Display, Atom]
    X.XFree.argtypes = [c_void_p]
    X.XSelectInput.argtypes = [Display, Window, c_long]
    X.XPending.argtypes = [Display]
    X.XNextEvent.argtypes = [Display, POINTER(XEvent)]
    X.XMapWindow.argtypes = [Display, Window]
    X.XRaiseWindow.argtypes = [Display, Window]
    X.XMoveResizeWindow.argtypes = [Display, Window, c_int, c_int, c_uint, c_uint]
    X.XConfigureWindow.argtypes = [Display, Window, c_uint, POINTER(XWindowChanges)]
    X.XSetInputFocus.argtypes = [Display, Window, c_int, Time]
    X.XGetWindowAttributes.argtypes = [Display, Window, POINTER(XWindowAttributes)]
    X.XGetTransientForHint.argtypes = [Display, Window, POINTER(Window)]
    X.XGetWindowProperty.argtypes = [Display, Window, Atom, c_long, c_long, c_int, Atom, POINTER(Atom),
                                     POINTER(c_int), POINTER(c_ulong), POINTER(c_ulong), POINTER(c_void_p)]
    X.XChangeProperty.argtypes = [Display, Window, Atom, Atom, c_int, c_int, c_void_p, c_int]
    X.XSendEvent.argtypes = [Display, Window, c_int, c_long, POINTER(XEvent)]
    X.XKillClient.argtypes = [Display, c_ulong]
    X.XFlush.argtypes = [Display]
    X.XSync.argtypes = [Display, c_int]
    X.XQueryPointer.argtypes = [Display, Window, POINTER(Window), POINTER(Window), POINTER(c_int),
                                POINTER(c_int), POINTER(c_int), POINTER(c_int), POINTER(c_uint)]
    X.XDisplayKeycodes.argtypes = [Display, POINTER(c_int), POINTER(c_int)]
    X.XGetKeyboardMapping.restype = POINTER(KeySym)
    X.XGetKeyboardMapping.argtypes = [Display, c_ubyte, c_int, POINTER(c_int)]
    X.XChangeKeyboardMapping.argtypes = [Display, c_int, c_int, POINTER(KeySym), c_int]
    X.XCreateSimpleWindow.restype = Window
    X.XCreateSimpleWindow.argtypes = [Display, Window, c_int, c_int, c_uint, c_uint, c_uint, c_ulong, c_ulong]
    X.XSetSelectionOwner.argtypes = [Display, Atom, Window, Time]
    X.XGetSelectionOwner.restype = Window
    X.XGetSelectionOwner.argtypes = [Display, Atom]
    X.XConvertSelection.argtypes = [Display, Atom, Atom, Atom, Window, Time]
    X.XDeleteProperty.argtypes = [Display, Window, Atom]
    if Xt:
        Xt.XTestFakeMotionEvent.argtypes = [Display, c_int, c_int, c_int, c_ulong]
        Xt.XTestFakeButtonEvent.argtypes = [Display, c_uint, c_int, c_ulong]
        Xt.XTestFakeKeyEvent.argtypes = [Display, c_uint, c_int, c_ulong]
    if Xf:
        Xf.XFixesQueryExtension.argtypes = [Display, POINTER(c_int), POINTER(c_int)]
        Xf.XFixesSelectCursorInput.argtypes = [Display, Window, c_ulong]
        Xf.XFixesGetCursorImage.restype = POINTER(XFixesCursorImage)
        Xf.XFixesGetCursorImage.argtypes = [Display]
        Xf.XFixesSelectSelectionInput.argtypes = [Display, Window, Atom, c_ulong]
    if Xd:
        Xd.XDamageQueryExtension.argtypes = [Display, POINTER(c_int), POINTER(c_int)]
        Xd.XDamageCreate.restype = c_ulong
        Xd.XDamageCreate.argtypes = [Display, Window, c_int]
        Xd.XDamageSubtract.argtypes = [Display, c_ulong, c_ulong, c_ulong]

# a window gone between the event and the call is the normal case for a WM; the
# default handler would exit the process over it
ERRH = ctypes.CFUNCTYPE(c_int, c_void_p, c_void_p)(lambda d, e: 0)

def fail(msg):
    out(t="exit", code=-1, error=msg, log=applog[-4000:].decode("utf8", "replace"))
    shutdown(1)

def shutdown(code):
    try:
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except OSError:
                pass
            for _ in range(20):
                if proc.poll() is not None:
                    break
                time.sleep(0.1)
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
        if xvfb and xvfb.poll() is None:
            xvfb.terminate()
            try:
                xvfb.wait(2)
            except Exception:
                xvfb.kill()
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)
        os._exit(code)

def die_with_parent():
    try:
        ctypes.CDLL(None).prctl(1, signal.SIGKILL)
    except Exception:
        pass

# --- the display ------------------------------------------------------------------

def free_display():
    for n in range(100, 400):
        if not os.path.exists("/tmp/.X11-unix/X%d" % n) and not os.path.exists("/tmp/.X%d-lock" % n):
            return n
    fail("no free X display number")

def write_auth(path, n, cookie):
    def f(b):
        return struct.pack(">H", len(b)) + b
    # FamilyWild: any address, this display
    with open(path, "wb") as fh:
        fh.write(struct.pack(">H", 0xFFFF) + f(b"") + f(str(n).encode()) + f(b"MIT-MAGIC-COOKIE-1") + f(cookie))
    os.chmod(path, 0o600)

def start_xvfb(sw, sh, dpi):
    global xvfb, tmpdir
    if not shutil.which("Xvfb"):
        fail("Xvfb isn't installed on this host (apt install xvfb)")
    base = os.environ.get("XDG_RUNTIME_DIR") or None
    if base and not os.access(base, os.W_OK):
        base = None
    tmpdir = tempfile.mkdtemp(prefix="phos-app-", dir=base)
    auth = os.path.join(tmpdir, "Xauthority")
    for _ in range(5):
        n = free_display()
        write_auth(auth, n, os.urandom(16))
        xvfb = subprocess.Popen(["Xvfb", ":%d" % n, "-screen", "0", "%dx%dx24" % (sw, sh), "-auth", auth,
                                 "-nolisten", "tcp", "-dpi", str(dpi), "-noreset", "+extension", "RANDR"],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                preexec_fn=die_with_parent)
        os.environ["XAUTHORITY"] = auth
        for _ in range(100):
            if xvfb.poll() is not None:
                break
            if os.path.exists("/tmp/.X11-unix/X%d" % n):
                d = X.XOpenDisplay((":%d" % n).encode())
                if d:
                    return n, auth, d
            time.sleep(0.05)
        if xvfb.poll() is None:
            xvfb.kill()
        err = xvfb.stderr.read().decode("utf8", "replace") if xvfb.stderr else ""
        if "already active" not in err and "Server is already" not in err:
            fail("Xvfb didn't start: " + err[-600:])
    fail("Xvfb didn't start")

def atom(name):
    return X.XInternAtom(dpy, name.encode(), 0)

def atom_name(a):
    if not a:
        return ""
    p = X.XGetAtomName(dpy, a)
    if not p:
        return ""
    s = ctypes.string_at(p).decode("utf8", "replace")
    X.XFree(p)
    return s

def prop(w, name, kind=0, maxlen=65536):
    t, f, n, left, data = Atom(), c_int(), c_ulong(), c_ulong(), c_void_p()
    if X.XGetWindowProperty(dpy, w, atom(name) if isinstance(name, str) else name, 0, maxlen // 4, 0, kind,
                            byref(t), byref(f), byref(n), byref(left), byref(data)) != 0 or not data.value:
        return None, 0, b""
    size = {8: 1, 16: ctypes.sizeof(c_short), 32: ctypes.sizeof(c_long)}.get(f.value, 1)
    raw = ctypes.string_at(data.value, n.value * size)
    X.XFree(data)
    return t.value, f.value, raw

def atoms_of(w, name):
    _, f, raw = prop(w, name)
    if f != 32:
        return []
    k = ctypes.sizeof(c_long)
    return [int.from_bytes(raw[i:i + k], sys.byteorder) for i in range(0, len(raw), k)]

def title_of(w):
    _, _, raw = prop(w, "_NET_WM_NAME")
    if not raw:
        t, _, raw = prop(w, "WM_NAME")
        # COMPOUND_TEXT: UTF-8 runs between ESC % G and ESC % @, Latin-1 outside
        if t and atom_name(t) == "COMPOUND_TEXT":
            out_ = []
            for i, part in enumerate(raw.split(b"\x1b%G")):
                utf, _, rest = part.partition(b"\x1b%@") if i else (b"", b"", part)
                out_.append(utf.decode("utf8", "replace"))
                out_.append(re.sub(rb"\x1b[-(][A-Z@]", b"", rest).decode("latin1"))
            return "".join(out_)[:300]
        if t and atom_name(t) == "STRING":
            return raw.decode("latin1")[:300]
    return raw.decode("utf8", "replace")[:300]

# --- the window manager -------------------------------------------------------------

vw, vh = 800, 600
wins = []           # managed, bottom to top
full = set()        # those that fill the viewport
geo = {}            # each one's x, y, w, h as last set
mainwin = 0
last_title = None
last_list = None

def is_dialog(w):
    tf = Window()
    if X.XGetTransientForHint(dpy, w, byref(tf)) and tf.value:
        return True
    types = set(atom_name(a) for a in atoms_of(w, "_NET_WM_WINDOW_TYPE"))
    return bool(types & {"_NET_WM_WINDOW_TYPE_DIALOG", "_NET_WM_WINDOW_TYPE_UTILITY", "_NET_WM_WINDOW_TYPE_SPLASH",
                         "_NET_WM_WINDOW_TYPE_TOOLBAR", "_NET_WM_WINDOW_TYPE_NOTIFICATION"})

def place(w, rw=None, rh=None, rx=None, ry=None):
    if w in full:
        x, y, ww, hh = 0, 0, vw, vh
    else:
        a = XWindowAttributes()
        X.XGetWindowAttributes(dpy, w, byref(a))
        ww = max(1, min(rw or a.width, vw))
        hh = max(1, min(rh or a.height, vh))
        if rx is not None and ry is not None:
            x, y = max(0, min(rx, vw - ww)), max(0, min(ry, vh - hh))
        else:
            x, y = (vw - ww) // 2, (vh - hh) // 2
    geo[w] = (x, y, ww, hh)
    X.XMoveResizeWindow(dpy, w, x, y, ww, hh)
    synthetic_configure(w)

# ICCCM: a client told where it is even when its request wasn't the answer
def synthetic_configure(w):
    x, y, ww, hh = geo[w]
    e = XEvent()
    c = ctypes.cast(byref(e), POINTER(XConfigureEvent)).contents
    c.type, c.event, c.window, c.x, c.y, c.width, c.height = ConfigureNotify, w, w, x, y, ww, hh
    c.border_width, c.above, c.override_redirect = 0, 0, 0
    X.XSendEvent(dpy, w, 0, StructureNotify, byref(e))

def focus(w):
    if w in wins:
        wins.remove(w)
        wins.append(w)
    X.XRaiseWindow(dpy, w)
    X.XSetInputFocus(dpy, w, 1, 0)

def manage(w):
    global mainwin
    a = XWindowAttributes()
    if not X.XGetWindowAttributes(dpy, w, byref(a)) or a.override_redirect:
        X.XMapWindow(dpy, w)
        return
    if w not in wins:
        wins.append(w)
        if not is_dialog(w):
            full.add(w)
        X.XSelectInput(dpy, w, PropertyChange | StructureNotify)
    place(w)
    X.XMapWindow(dpy, w)
    focus(w)
    pick_main()

def unmanage(w):
    if w in wins:
        wins.remove(w)
        full.discard(w)
        geo.pop(w, None)
        if wins:
            X.XSetInputFocus(dpy, wins[-1], 1, 0)
        pick_main()

def pick_main():
    global mainwin
    tops = [w for w in wins if w in full]
    mainwin = tops[-1] if tops else (wins[-1] if wins else 0)
    report()

def report():
    global last_title, last_list
    t = title_of(mainwin) if mainwin else ""
    if t != last_title:
        last_title = t
        out(t="title", s=t)
    lst = [[w, title_of(w)] for w in wins]
    if lst != last_list:
        last_list = lst
        out(t="windows", list=lst, main=mainwin)

def resize_view(w, h):
    global vw, vh
    vw, vh = max(64, min(w, sw)), max(64, min(h, sh))
    for x in wins:
        place(x)
    if pixels_on:
        refresh()

def close_main():
    w = wins[-1] if wins else 0
    if not w:
        return
    if atom("WM_DELETE_WINDOW") in atoms_of(w, "WM_PROTOCOLS"):
        e = XEvent()
        c = ctypes.cast(byref(e), POINTER(XClientMessageEvent)).contents
        c.type, c.window, c.message_type, c.format = ClientMessage, w, atom("WM_PROTOCOLS"), 32
        c.l[0], c.l[1] = atom("WM_DELETE_WINDOW"), 0
        X.XSendEvent(dpy, w, 0, 0, byref(e))
    else:
        X.XKillClient(dpy, w)

# --- the keyboard and pointer -------------------------------------------------------

kmin, kmax, per = 8, 255, 1
by_sym = {}         # keysym -> (keycode, level)
spare = []
spare_i = 0
held = {}           # the viewer's key id -> keycode it pressed
shift_kc = 50

def load_keymap():
    global kmin, kmax, per, spare, shift_kc
    a, b = c_int(), c_int()
    X.XDisplayKeycodes(dpy, byref(a), byref(b))
    kmin, kmax = a.value, b.value
    n = c_int()
    m = X.XGetKeyboardMapping(dpy, kmin, kmax - kmin + 1, byref(n))
    per = n.value
    by_sym.clear()
    spare = []
    for kc in range(kmin, kmax + 1):
        syms = [m[(kc - kmin) * per + i] for i in range(per)]
        if not any(syms):
            spare.append(kc)
        for lvl, s in enumerate(syms[:2]):
            if s and (s not in by_sym or by_sym[s][1] > lvl):
                by_sym[s] = (kc, lvl)
    X.XFree(m)
    shift_kc = by_sym.get(0xFFE1, (50, 0))[0]
    spare = spare[-8:]

def remap(sym):
    global spare_i
    if not spare:
        return 0
    kc = spare[spare_i % len(spare)]
    spare_i += 1
    arr = (KeySym * 2)(sym, sym)
    X.XChangeKeyboardMapping(dpy, kc, 2, arr, 1)
    X.XSync(dpy, 0)
    for s, v in list(by_sym.items()):
        if v[0] == kc:
            del by_sym[s]
    by_sym[sym] = (kc, 0)
    return kc

shifts = set()      # the shift keycodes held

def key(down, kc, sym, kid):
    if not Xt:
        return
    if not down:
        k = held.pop(kid, kc)
        if k:
            Xt.XTestFakeKeyEvent(dpy, k, 0, 0)
            shifts.discard(k)
        return
    k, lvl = 0, -1
    if sym and sym in by_sym:
        k, lvl = by_sym[sym]
    elif sym and 0x20 <= (sym & 0xFFFFFF) and (sym < 0xFF00 or sym >= 0x01000000):
        k = remap(sym)
    if not k:
        k, lvl = kc, -1
    if not k:
        return
    held[kid] = k
    # a character at the other shift level than the viewer's held shift: shift pressed
    # or let go around it, as their layout and this display's differ
    press = lvl == 1 and not shifts
    lift = lvl == 0 and bool(shifts) and sym < 0xFF00
    if press:
        Xt.XTestFakeKeyEvent(dpy, shift_kc, 1, 0)
    for s in (shifts if lift else ()):
        Xt.XTestFakeKeyEvent(dpy, s, 0, 0)
    Xt.XTestFakeKeyEvent(dpy, k, 1, 0)
    if press:
        Xt.XTestFakeKeyEvent(dpy, shift_kc, 0, 0)
    for s in (shifts if lift else ()):
        Xt.XTestFakeKeyEvent(dpy, s, 1, 0)
    if sym in (0xFFE1, 0xFFE2) or (lvl < 0 and kc in (50, 62)):
        shifts.add(k)

def sym_of(ch):
    o = ord(ch)
    if ch == "\n":
        return 0xFF0D
    if ch == "\t":
        return 0xFF09
    return o if (0x20 <= o <= 0x7E or 0xA0 <= o <= 0xFF) else 0x01000000 + o

def type_text(s):
    for ch in s[:4096]:
        sym = sym_of(ch)
        key(True, 0, sym, "_t")
        key(False, 0, sym, "_t")
        X.XFlush(dpy)

def button(n, down):
    if not Xt or not (1 <= n <= 9):
        return
    if down and n <= 3:
        r, c = Window(), Window()
        i = c_int()
        u = c_uint()
        X.XQueryPointer(dpy, root, byref(r), byref(c), byref(i), byref(i), byref(i), byref(i), byref(u))
        if c.value in wins and wins and c.value != wins[-1]:
            focus(c.value)
            report()
    Xt.XTestFakeButtonEvent(dpy, n, 1 if down else 0, 0)

def wheel(dx, dy):
    if not Xt:
        return
    for n, count in ((4, -dy), (5, dy), (6, -dx), (7, dx)):
        for _ in range(max(0, min(int(count), 20))):
            Xt.XTestFakeButtonEvent(dpy, n, 1, 0)
            Xt.XTestFakeButtonEvent(dpy, n, 0, 0)

# --- the pointer's shape -------------------------------------------------------------

last_cursor = None

def cursor_changed():
    global last_cursor
    img = Xf.XFixesGetCursorImage(dpy)
    if not img:
        return
    c = img.contents
    name = c.name.decode("utf8", "replace") if c.name else ""
    key_ = name or c.cursor_serial
    if key_ == last_cursor:
        X.XFree(img)
        return
    last_cursor = key_
    if name:
        out(t="cursor", name=name)
    elif c.width and c.height and c.width <= 128 and c.height <= 128:
        rows = []
        for y in range(c.height):
            row = bytearray(b"\0")
            for x in range(c.width):
                p = c.pixels[y * c.width + x] & 0xFFFFFFFF
                a = p >> 24
                # premultiplied in the server, straight in a PNG
                r, g, b = ((p >> 16) & 255, (p >> 8) & 255, p & 255)
                if a:
                    r, g, b = min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a)
                row += bytes((r, g, b, a))
            rows.append(bytes(row))
        out(t="cursor", png=base64.b64encode(png(c.width, c.height, b"".join(rows))).decode(), x=c.xhot, y=c.yhot)
    X.XFree(img)

def png(w, h, raw):
    def chunk(k, d):
        return struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))

# --- the pixels: the rectangles that changed, read off the display as they change -----

pixels_on = False
damage = 0
damage_base = -1
dirty = []          # damaged since the last flush: x, y, w, h on the display
dirty_at = 0.0
last_flush = 0.0
# while video streams instead: how much changes, told twice a second as pixels damaged
motion_on = False
motion_px = 0
motion_at = 0.0
MOTION_EVERY = 0.5
# changes gathered this long before they're read: one read for a burst of drawing
GATHER = 0.005
# and read no more often than this: a flood of change stays a stream of rectangles
FLUSH_GAP = 0.008
MAX_RECTS = 8
said_depth = False

def write_all(b):
    mv = memoryview(b)
    while mv:
        try:
            n = os.write(1, mv)
        except OSError:
            shutdown(0)
        mv = mv[n:]

# rectangles merged where they touch (within pad), the lot's bounding box when still
# more than limit: few reads, little sent twice
def merge_rects(rs, limit=MAX_RECTS, pad=2):
    bs = [(x, y, x + w, y + h) for x, y, w, h in rs if w > 0 and h > 0]
    changed = True
    while changed and len(bs) > 1:
        changed = False
        done = []
        while bs:
            a = bs.pop()
            i = 0
            while i < len(bs):
                b = bs[i]
                if a[0] - pad < b[2] and b[0] - pad < a[2] and a[1] - pad < b[3] and b[1] - pad < a[3]:
                    a = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
                    bs.pop(i)
                    changed = True
                else:
                    i += 1
            done.append(a)
        bs = done
    if len(bs) > limit:
        bs = [(min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))]
    return [(x0, y0, x1 - x0, y1 - y0) for x0, y0, x1, y1 in bs]

# one rectangle of the view, read and sent: its header a JSON line, its pixels after
def send_rect(x, y, w, h):
    global said_depth
    x0, y0, x1, y1 = max(0, x), max(0, y), min(vw, x + w), min(vh, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    img = X.XGetImage(dpy, root, x0, y0, x1 - x0, y1 - y0, 0xFFFFFFFF, 2)
    if not img:
        return
    i = img.contents
    try:
        if i.bits_per_pixel != 32:
            if not said_depth:
                said_depth = True
                out(t="log", s="the display isn't 32 bits a pixel; no pixels sent")
            return
        bpl, rw, rh = i.bytes_per_line, i.width, i.height
        raw = ctypes.string_at(i.data, bpl * rh)
        if bpl != rw * 4:
            raw = b"".join(raw[r * bpl:r * bpl + rw * 4] for r in range(rh))
        order = i.byte_order
    finally:
        i.f.destroy_image(img)
    z = zlib.compress(raw, 1)
    head = json.dumps({"t": "rect", "x": x0, "y": y0, "w": rw, "h": rh, "n": len(z), "z": 1, "o": order},
                      separators=(",", ":")).encode() + b"\n"
    write_all(head + z)

def flush_rects():
    global dirty, dirty_at, last_flush
    rs = merge_rects(dirty)
    dirty = []
    dirty_at = 0.0
    last_flush = time.time()
    if damage:
        Xd.XDamageSubtract(dpy, damage, 0, 0)
    if pixels_on:
        for r in rs:
            send_rect(*r)

# the whole view again: a viewer that comes or fell behind, a resize
def refresh():
    global dirty, dirty_at
    if not pixels_on:
        return
    dirty = []
    dirty_at = 0.0
    if damage:
        Xd.XDamageSubtract(dpy, damage, 0, 0)
    out(t="size", w=vw, h=vh)
    send_rect(0, 0, vw, vh)

# XDamage on the whole display, once: raw rectangles, each change as drawn, merged here
def want_damage():
    global damage, damage_base
    if damage or not Xd:
        return bool(damage)
    a, b = c_int(), c_int()
    if Xd.XDamageQueryExtension(dpy, byref(a), byref(b)):
        damage_base = a.value
        damage = Xd.XDamageCreate(dpy, root, 0)
    return bool(damage)

def set_pixels(on):
    global pixels_on, dirty
    on = bool(on) and want_damage()
    pixels_on = on
    dirty = []
    if on:
        refresh()
    elif damage:
        Xd.XDamageSubtract(dpy, damage, 0, 0)

def set_motion(on):
    global motion_on, motion_px, motion_at
    motion_on = bool(on) and want_damage()
    motion_px = 0
    motion_at = time.time()

def flush_motion():
    global motion_px, motion_at
    motion_at = time.time()
    out(t="motion", px=motion_px)
    motion_px = 0
    if damage and not pixels_on:
        Xd.XDamageSubtract(dpy, damage, 0, 0)

# --- the clipboard -------------------------------------------------------------------

clipwin = 0
clip_text = b""
fixes_base = -1

def own_clipboard(text):
    global clip_text
    clip_text = text.encode("utf8")[:1 << 20]
    for sel in ("CLIPBOARD", "PRIMARY"):
        X.XSetSelectionOwner(dpy, atom(sel), clipwin, 0)

def answer_request(e):
    r = ctypes.cast(byref(e), POINTER(XSelectionRequestEvent)).contents
    utf8, targets = atom("UTF8_STRING"), atom("TARGETS")
    p = r.property or r.target
    ok = True
    if r.target == targets:
        arr = (c_long * 4)(targets, utf8, atom("STRING"), atom("TEXT"))
        X.XChangeProperty(dpy, r.requestor, p, atom("ATOM"), 32, 0, arr, 4)
    elif r.target in (utf8, atom("STRING"), atom("TEXT"), atom("text/plain;charset=utf-8")):
        buf = ctypes.create_string_buffer(clip_text, len(clip_text))
        X.XChangeProperty(dpy, r.requestor, p, utf8 if r.target != atom("STRING") else atom("STRING"), 8, 0,
                          buf, len(clip_text))
    else:
        ok = False
    n = XEvent()
    s = ctypes.cast(byref(n), POINTER(XSelectionEvent)).contents
    s.type, s.requestor, s.selection, s.target = SelectionNotify, r.requestor, r.selection, r.target
    s.property, s.time = (p if ok else 0), r.time
    X.XSendEvent(dpy, r.requestor, 0, 0, byref(n))

def host_copied(e):
    s = ctypes.cast(byref(e), POINTER(XFixesSelectionNotifyEvent)).contents
    if s.owner and s.owner != clipwin:
        X.XConvertSelection(dpy, atom("CLIPBOARD"), atom("UTF8_STRING"), atom("PHOS_CLIP"), clipwin, 0)

def got_selection(e):
    s = ctypes.cast(byref(e), POINTER(XSelectionEvent)).contents
    if s.requestor != clipwin or not s.property:
        return
    _, _, raw = prop(clipwin, s.property, 0, 1 << 20)
    X.XDeleteProperty(dpy, clipwin, s.property)
    if raw:
        out(t="clip", s=raw.decode("utf8", "replace"))

# --- input from the viewer ----------------------------------------------------------

def on_line(line):
    try:
        m = json.loads(line)
    except ValueError:
        return
    if not isinstance(m, list) or not m:
        return
    k = m[0]
    if k == "m" and Xt:
        Xt.XTestFakeMotionEvent(dpy, -1, max(0, min(int(m[1]), vw - 1)), max(0, min(int(m[2]), vh - 1)), 0)
    elif k == "b":
        button(int(m[1]), bool(m[2]))
    elif k == "w":
        wheel(int(m[1]), int(m[2]))
    elif k == "k":
        key(bool(m[1]), int(m[2]), int(m[3]), str(m[4]) if len(m) > 4 else str(m[2]))
    elif k == "x":
        type_text(str(m[1]))
    elif k == "r":
        resize_view(int(m[1]), int(m[2]))
    elif k == "raise":
        w = int(m[1])
        if w in wins:
            focus(w)
            report()
    elif k == "clip":
        own_clipboard(str(m[1]))
    elif k == "pixels":
        set_pixels(m[1] if len(m) > 1 else True)
    elif k == "refresh":
        refresh()
    elif k == "motion":
        set_motion(m[1] if len(m) > 1 else True)
    elif k == "close":
        close_main()
    elif k == "quit":
        shutdown(0)
    X.XFlush(dpy)

def on_x():
    global dirty_at, motion_px
    e = XEvent()
    while X.XPending(dpy):
        X.XNextEvent(dpy, byref(e))
        t = e.type
        if t == MapRequest:
            manage(ctypes.cast(byref(e), POINTER(XMapRequestEvent)).contents.window)
        elif t == ConfigureRequest:
            r = ctypes.cast(byref(e), POINTER(XConfigureRequestEvent)).contents
            if r.window in wins:
                if r.window in full:
                    synthetic_configure(r.window)
                else:
                    x, y, _, _ = geo.get(r.window, (0, 0, 0, 0))
                    place(r.window, r.width if r.value_mask & CWWidth else None,
                          r.height if r.value_mask & CWHeight else None,
                          r.x if r.value_mask & CWX else x, r.y if r.value_mask & CWY else y)
            else:
                c = XWindowChanges(r.x, r.y, r.width, r.height, r.border_width, r.above, r.detail)
                X.XConfigureWindow(dpy, r.window, r.value_mask & 0x7F, byref(c))
        elif t in (UnmapNotify, DestroyNotify):
            u = ctypes.cast(byref(e), POINTER(XUnmapEvent)).contents
            unmanage(u.window)
        elif t == PropertyNotify:
            p = ctypes.cast(byref(e), POINTER(XPropertyEvent)).contents
            if p.window in wins and atom_name(p.atom) in ("_NET_WM_NAME", "WM_NAME"):
                report()
        elif t == SelectionRequest:
            answer_request(e)
        elif t == SelectionNotify:
            got_selection(e)
        elif t == 34:  # MappingNotify
            load_keymap()
        elif fixes_base >= 0 and t == fixes_base + 1:
            cursor_changed()
        elif fixes_base >= 0 and t == fixes_base:
            host_copied(e)
        elif damage_base >= 0 and t == damage_base:
            d = ctypes.cast(byref(e), POINTER(XDamageNotifyEvent)).contents
            if pixels_on:
                dirty.append((d.area.x, d.area.y, d.area.width, d.area.height))
                dirty_at = dirty_at or time.time()
            elif motion_on:
                motion_px += d.area.width * d.area.height
    X.XFlush(dpy)

# --- the app ---------------------------------------------------------------------------

def launch(argv, display, scale, dbus):
    global proc
    env = dict(os.environ)
    for k in ("WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DESKTOP_STARTUP_ID", "XDG_ACTIVATION_TOKEN"):
        env.pop(k, None)
    env.update(DISPLAY=display, XDG_SESSION_TYPE="x11", GDK_BACKEND="x11", QT_QPA_PLATFORM="xcb",
               SDL_VIDEODRIVER="x11", MOZ_ENABLE_WAYLAND="0", ELECTRON_OZONE_PLATFORM_HINT="x11",
               NO_AT_BRIDGE="1", _JAVA_AWT_WM_NONREPARENTING="1")
    if scale >= 1.5:
        env["GDK_SCALE"] = str(int(round(scale)))
        env["QT_SCALE_FACTOR"] = str(round(scale, 2))
    # its own session bus: a single-instance app starts here rather than handing its
    # window to a copy already open on the host's own screen
    if dbus and shutil.which("dbus-run-session"):
        env.pop("DBUS_SESSION_BUS_ADDRESS", None)
        argv = ["dbus-run-session", "--"] + argv
    if not shutil.which(argv[0]) and not os.path.isfile(argv[0]):
        fail("%s isn't on this host's PATH" % argv[0])
    try:
        proc = subprocess.Popen(argv, env=env, cwd=os.path.expanduser("~"), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as e:
        fail("couldn't start %s: %s" % (argv[0], e))

def main():
    global dpy, root, sw, sh, clipwin, fixes_base, applog
    buf = b""
    while b"\n" not in buf:
        r = os.read(0, 65536)
        if not r:
            shutdown(0)
        buf += r
    first, buf = buf.split(b"\n", 1)
    cfg = json.loads(first)
    argv = [str(a) for a in cfg.get("argv") or []]
    if not argv:
        fail("nothing to run")
    setup_libs()
    if not Xt:
        out(t="log", s="libXtst isn't on this host: view only")
    sw, sh = int(cfg.get("sw", 1920)), int(cfg.get("sh", 1080))
    n, auth, dpy = start_xvfb(sw, sh, int(cfg.get("dpi", 96)))
    X.XSetErrorHandler(ERRH)
    root = X.XDefaultRootWindow(dpy)
    X.XSelectInput(dpy, root, SubstructureRedirect | SubstructureNotify)
    clipwin = X.XCreateSimpleWindow(dpy, root, -10, -10, 1, 1, 0, 0, 0)
    a, b = c_int(), c_int()
    if Xf and Xf.XFixesQueryExtension(dpy, byref(a), byref(b)):
        fixes_base = a.value
        Xf.XFixesSelectCursorInput(dpy, root, 1)
        Xf.XFixesSelectSelectionInput(dpy, root, atom("CLIPBOARD"), 1)
    load_keymap()
    resize_view(int(cfg.get("w", 1280)), int(cfg.get("h", 720)))
    X.XSync(dpy, 0)
    launch(argv, ":%d" % n, float(cfg.get("scale", 1)), bool(cfg.get("dbus", True)))
    out(t="ready", display=":%d" % n, auth=auth, w=vw, h=vh, xtest=bool(Xt), pixels=bool(Xd))
    xfd = X.XConnectionNumber(dpy)
    afd = proc.stdout.fileno()
    seen_window = False
    gone_at = 0.0
    if buf:
        for line in buf.split(b"\n"):
            if line.strip():
                on_line(line)
        buf = b""
    while True:
        fds = [0, xfd] + ([afd] if afd >= 0 else [])
        wait = 0.25
        if dirty:
            wait = max(0.0, min(GATHER - (time.time() - dirty_at), FLUSH_GAP - (time.time() - last_flush)))
        r, _, _ = select.select(fds, [], [], wait)
        if 0 in r:
            d = os.read(0, 65536)
            if not d:
                shutdown(0)
            buf += d
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.strip():
                    on_line(line)
        if afd in r:
            d = os.read(afd, 65536)
            if d:
                applog = (applog + d)[-16000:]
            else:
                afd = -1
        on_x()
        if dirty:
            now = time.time()
            if now - dirty_at >= GATHER and now - last_flush >= FLUSH_GAP:
                flush_rects()
        if motion_on and not pixels_on and time.time() - motion_at >= MOTION_EVERY:
            flush_motion()
        if wins:
            seen_window, gone_at = True, 0.0
        if proc.poll() is not None and not wins:
            # a launcher that exits after handing off waits a moment for its window
            gone_at = gone_at or time.time()
            if seen_window or time.time() - gone_at > 3:
                out(t="exit", code=proc.returncode, log=applog[-4000:].decode("utf8", "replace"),
                    error="" if seen_window else ("it exited before opening a window; an app open already (on the host's "
                                                       "screen, or streamed) may have taken the window itself"))
                shutdown(0)
        if xvfb.poll() is not None:
            fail("the X server stopped")

sw, sh = 1920, 1080
if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        out(t="exit", code=-1, error="agent: %s" % e, log=traceback.format_exc()[-3000:])
        shutdown(1)
