// a browser's key into an X server's: the physical key as an evdev keycode (+8),
// the character it made as a keysym, which the agent prefers when its keymap has it,
// so the viewer's layout wins over the display's

const evdev: Record<string, number> = {
  Escape: 1,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  BracketLeft: 26,
  BracketRight: 27,
  Enter: 28,
  ControlLeft: 29,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  ShiftLeft: 42,
  Backslash: 43,
  Comma: 51,
  Period: 52,
  Slash: 53,
  ShiftRight: 54,
  NumpadMultiply: 55,
  AltLeft: 56,
  Space: 57,
  CapsLock: 58,
  NumLock: 69,
  ScrollLock: 70,
  Numpad7: 71,
  Numpad8: 72,
  Numpad9: 73,
  NumpadSubtract: 74,
  Numpad4: 75,
  Numpad5: 76,
  Numpad6: 77,
  NumpadAdd: 78,
  Numpad1: 79,
  Numpad2: 80,
  Numpad3: 81,
  Numpad0: 82,
  NumpadDecimal: 83,
  IntlBackslash: 86,
  F11: 87,
  F12: 88,
  IntlRo: 89,
  NumpadEnter: 96,
  ControlRight: 97,
  NumpadDivide: 98,
  PrintScreen: 99,
  AltRight: 100,
  Home: 102,
  ArrowUp: 103,
  PageUp: 104,
  ArrowLeft: 105,
  ArrowRight: 106,
  End: 107,
  ArrowDown: 108,
  PageDown: 109,
  Insert: 110,
  Delete: 111,
  AudioVolumeMute: 113,
  AudioVolumeDown: 114,
  AudioVolumeUp: 115,
  NumpadEqual: 117,
  Pause: 119,
  NumpadComma: 121,
  IntlYen: 124,
  MetaLeft: 125,
  MetaRight: 126,
  ContextMenu: 127,
};
"1234567890".split("").forEach((d, i) => (evdev[`Digit${d}`] = i + 2));
for (const [row, start] of [
  ["QWERTYUIOP", 16],
  ["ASDFGHJKL", 30],
  ["ZXCVBNM", 44],
] as const)
  row.split("").forEach((k, i) => (evdev[`Key${k}`] = start + i));
for (let i = 1; i <= 10; i++) evdev[`F${i}`] = 58 + i;
for (let i = 13; i <= 24; i++) evdev[`F${i}`] = 170 + i;

// KeyboardEvent.code's X keycode, 0 for none
export const keycodeOf = (code: string) => (evdev[code] ?? -8) + 8;

const named: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Pause: 0xff13,
  ScrollLock: 0xff14,
  Escape: 0xff1b,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  PrintScreen: 0xff61,
  Insert: 0xff63,
  ContextMenu: 0xff67,
  NumLock: 0xff7f,
  Shift: 0xffe1,
  Control: 0xffe3,
  CapsLock: 0xffe5,
  Meta: 0xffeb,
  Alt: 0xffe9,
  AltGraph: 0xfe03,
  Delete: 0xffff,
};
for (let i = 1; i <= 24; i++) named[`F${i}`] = 0xffbd + i;

// the keysym a key made: its character's, a named key's, 0 when the physical key
// should be pressed instead (a modifier held: shortcuts follow the key, not the letter)
export function keysymOf(key: string, code: string, chord: boolean): number {
  if (/Right$/.test(code) && (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta"))
    return named[key]! + 1;
  if (named[key] !== undefined) return named[key]!;
  const cps = [...key];
  if (cps.length !== 1) return 0;
  if (chord && evdev[code] !== undefined) return 0;
  const cp = cps[0]!.codePointAt(0)!;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return cp < 0x20 ? 0 : 0x01000000 + cp;
}
