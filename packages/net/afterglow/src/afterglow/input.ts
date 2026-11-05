// the viewer's input as afterglow's input packets (docs/protocol.md, host/src/input.rs):
// a size, a kind, the event. Keys go as US-layout Windows virtual keys, the physical
// key, or as text where the viewer's layout differs so it wins; a paste is the page's
// clipboard typed

export const Magic = {
  keyDown: 0x03,
  keyUp: 0x04,
  mouseAbs: 0x05,
  mouseRel: 0x07,
  buttonDown: 0x08,
  buttonUp: 0x09,
  scroll: 0x0a,
  utf8: 0x17,
  hscroll: 0x55000001,
} as const;

// one input packet: size (big-endian, of everything after it), magic, the event
function input(magic: number, body: number): [Uint8Array, DataView] {
  const b = new Uint8Array(8 + body);
  const v = new DataView(b.buffer);
  v.setUint32(0, 4 + body, false);
  v.setUint32(4, magic, true);
  return [b, v];
}

export const pack = {
  mouseAbs(x: number, y: number, w: number, h: number) {
    const [b, v] = input(Magic.mouseAbs, 10);
    v.setInt16(8, x, false);
    v.setInt16(10, y, false);
    v.setInt16(12, 0, false);
    v.setInt16(14, w - 1, false);
    v.setInt16(16, h - 1, false);
    return b;
  },
  mouseRel(dx: number, dy: number) {
    const [b, v] = input(Magic.mouseRel, 4);
    v.setInt16(8, dx, false);
    v.setInt16(10, dy, false);
    return b;
  },
  button(down: boolean, button: number) {
    const [b] = input(down ? Magic.buttonDown : Magic.buttonUp, 1);
    b[8] = button;
    return b;
  },
  key(down: boolean, vk: number, mods: number, flags = 0) {
    const [b, v] = input(down ? Magic.keyDown : Magic.keyUp, 6);
    b[8] = flags;
    v.setUint16(9, (vk & 0xff) | 0x8000, true);
    b[11] = mods;
    v.setUint16(12, 0, true);
    return b;
  },
  // one notch is 120
  scroll(amount: number) {
    const [b, v] = input(Magic.scroll, 6);
    v.setInt16(8, amount, false);
    v.setInt16(10, amount, false);
    v.setInt16(12, 0, false);
    return b;
  },
  hscroll(amount: number) {
    const [b, v] = input(Magic.hscroll, 2);
    v.setInt16(8, amount, false);
    return b;
  },
  utf8(text: string) {
    const t = new TextEncoder().encode(text);
    const [b] = input(Magic.utf8, t.length);
    b.set(t, 8);
    return b;
  },
};

// a browser's key as a US-layout Windows virtual-key code: the physical key (the host
// maps it to a scan code). A character the viewer's layout makes and the US layout
// wouldn't on that key goes as text instead, so the viewer's layout wins

const vk: Record<string, number> = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  NumpadEnter: 0x0d,
  Pause: 0x13,
  CapsLock: 0x14,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  PrintScreen: 0x2c,
  Insert: 0x2d,
  Delete: 0x2e,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  ContextMenu: 0x5d,
  NumpadMultiply: 0x6a,
  NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d,
  NumpadDecimal: 0x6e,
  NumpadDivide: 0x6f,
  NumLock: 0x90,
  ScrollLock: 0x91,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  AudioVolumeMute: 0xad,
  AudioVolumeDown: 0xae,
  AudioVolumeUp: 0xaf,
  MediaTrackNext: 0xb0,
  MediaTrackPrevious: 0xb1,
  MediaStop: 0xb2,
  MediaPlayPause: 0xb3,
  Semicolon: 0xba,
  Equal: 0xbb,
  Comma: 0xbc,
  Minus: 0xbd,
  Period: 0xbe,
  Slash: 0xbf,
  Backquote: 0xc0,
  BracketLeft: 0xdb,
  Backslash: 0xdc,
  BracketRight: 0xdd,
  Quote: 0xde,
  IntlBackslash: 0xe2,
};
// what the US layout types on a key: unshifted, shifted
const us: Record<string, [string, string]> = {
  Space: [" ", " "],
  Semicolon: [";", ":"],
  Equal: ["=", "+"],
  Comma: [",", "<"],
  Minus: ["-", "_"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Backquote: ["`", "~"],
  BracketLeft: ["[", "{"],
  Backslash: ["\\", "|"],
  BracketRight: ["]", "}"],
  Quote: ["'", '"'],
  NumpadMultiply: ["*", "*"],
  NumpadAdd: ["+", "+"],
  NumpadSubtract: ["-", "-"],
  NumpadDecimal: [".", "."],
  NumpadDivide: ["/", "/"],
};
for (let i = 0; i < 26; i++) {
  const c = String.fromCharCode(97 + i);
  vk[`Key${c.toUpperCase()}`] = 0x41 + i;
  us[`Key${c.toUpperCase()}`] = [c, c.toUpperCase()];
}
const shifted = ")!@#$%^&*(";
for (let i = 0; i < 10; i++) {
  vk[`Digit${i}`] = 0x30 + i;
  vk[`Numpad${i}`] = 0x60 + i;
  us[`Digit${i}`] = [String(i), shifted[i]!];
  us[`Numpad${i}`] = [String(i), String(i)];
}
for (let i = 1; i <= 24; i++) vk[`F${i}`] = 0x6f + i;

// KeyboardEvent.code's virtual key, 0 for none
export const vkOf = (code: string) => vk[code] ?? 0;

export const modOf = (code: string) =>
  code.startsWith("Shift")
    ? 0x01
    : code.startsWith("Control")
      ? 0x02
      : code.startsWith("Alt")
        ? 0x04
        : code.startsWith("Meta")
          ? 0x08
          : 0;

// whether a printable key should go as text: the viewer's layout made a character
// the US layout doesn't put on that key. A chord (a shortcut) always goes as the key
export function asText(code: string, key: string, chord: boolean, shift: boolean): boolean {
  if (chord || [...key].length !== 1) return false;
  const cp = key.codePointAt(0)!;
  if (cp < 0x20 || cp === 0x7f) return false;
  const u = us[code];
  if (!u) return true;
  return u[shift ? 1 : 0] !== key && u[shift ? 0 : 1] !== key;
}

// the viewer's mouse buttons (X numbering) as afterglow's: 8 and 9 are its 4 and 5
const buttons: Record<number, number> = { 1: 1, 2: 2, 3: 3, 8: 4, 9: 5 };
const clamp = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

// one packet out
export type Send = (pkt: Uint8Array) => void;

export class InputPacker {
  private mods = 0;
  // keys typed as text: their key-up isn't sent
  private texted = new Set<string>();
  private clip?: { s: string; at: number };

  constructor(private send: Send) {}

  private key(down: boolean, code: string) {
    const v = vkOf(code);
    if (!v) return;
    const m = modOf(code);
    if (m) this.mods = down ? this.mods | m : this.mods & ~m;
    this.send(pack.key(down, v, this.mods));
  }

  private text(s: string) {
    if (s) this.send(pack.utf8(s));
  }

  // one input message from the viewer; sw, sh the video's size
  input(m: unknown[], sw: number, sh: number) {
    switch (m[0]) {
      case "m":
        return this.send(pack.mouseAbs(clamp(m[1], 0, sw - 1), clamp(m[2], 0, sh - 1), sw, sh));
      case "b": {
        const b = buttons[clamp(m[1], 1, 9)];
        if (b) this.send(pack.button(!!m[2], b));
        return;
      }
      case "w": {
        const dx = clamp(m[1], -20, 20);
        const dy = clamp(m[2], -20, 20);
        if (dy) this.send(pack.scroll(-dy * 120));
        if (dx) this.send(pack.hscroll(dx * 120));
        return;
      }
      case "k": {
        const down = !!m[1];
        const code = String(m[2] ?? "").slice(0, 32);
        const key = String(m[3] ?? "").slice(0, 32);
        const chord = !!m[4];
        if (!down && this.texted.delete(code)) return;
        // a paste: the page's clipboard typed, not the host's pasted
        if (down && code === "KeyV" && chord && this.clip && Date.now() - this.clip.at < 1000) {
          const t = this.clip.s;
          this.clip = undefined;
          for (const c of ["ControlLeft", "ControlRight", "MetaLeft", "MetaRight"])
            if (this.mods & modOf(c)) this.key(false, c);
          this.texted.add(code);
          return this.text(t);
        }
        if (down && asText(code, key, chord, (this.mods & 0x01) !== 0)) {
          this.texted.add(code);
          return this.text(key);
        }
        return this.key(down, code);
      }
      case "x":
        return this.text(String(m[1] ?? "").slice(0, 4096));
      case "clip":
        this.clip = { s: String(m[1] ?? "").slice(0, 64 << 10), at: Date.now() };
        return;
    }
  }
}
