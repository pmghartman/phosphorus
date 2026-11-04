// a browser's key as GameStream wants it: the physical key as a US-layout Windows
// virtual-key code (the host maps it to a scan code, so it is the key, not the
// letter). A character the viewer's layout makes and the US layout wouldn't on that
// key goes as text instead, so the viewer's layout wins, as it does on X

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

// text cut into GameStream's UTF-8 packets: at most 32 bytes, whole code points
export function utf8Chunks(text: string, max = 32): string[] {
  const out: string[] = [];
  let cur = "";
  let n = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch);
    if (n + b > max && cur) {
      out.push(cur);
      cur = "";
      n = 0;
    }
    cur += ch;
    n += b;
  }
  if (cur) out.push(cur);
  return out;
}
