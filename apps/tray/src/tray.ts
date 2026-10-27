// the tray's surface, one implementation per OS (mac.ts, tray-win32.ts): an icon
// with a tooltip and a menu, its OS events pumped beside bun's event loop
export type TrayItem = { label?: string; enabled?: boolean; separator?: boolean; onClick?: () => void };

export interface Tray {
  // the icon's file as bytes: an .ico on Windows, a PNG shown as a template on macOS
  setIcon(icon: Uint8Array): void;
  setTooltip(text: string): void;
  // the whole menu, replaced; a click runs its item's onClick once the menu has closed
  setMenu(items: TrayItem[]): void;
  // the OS's events pumped on a timer until quit; left and right click both open the menu
  run(): void;
  // the icon gone and the pump stopped; the caller exits
  quit(): void;
}

// a NUL-terminated UTF-8 string for the ffi, kept alive by its caller
export const cstr = (s: string) => Buffer.from(s + "\0", "utf8");

// a NUL-terminated UTF-16 string for the ffi, kept alive by its caller
export const wstr = (s: string) => {
  const b = Buffer.alloc((s.length + 1) * 2);
  b.write(s, "utf16le");
  return b;
};
