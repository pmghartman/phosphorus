// phosphorus's theme library: every color, font, shadow and corner token of its one theme,
// in theme.json, the source the desktop, the terminals and the tray all draw from; light and
// black each lay over dark. The web build turns it into CSS (css); callers resolve a mode's tokens
import raw from "../theme.json" with { type: "json" };

// the theme's custom properties ("--bg") and the odd plain property ("color-scheme")
export type Tokens = Record<string, string>;
export const MODES = ["dark", "light", "black"] as const;
export type Mode = (typeof MODES)[number];
export type ThemeData = { dark: Tokens; light: Tokens; black: Tokens; ide: Tokens };

const data = raw as unknown as ThemeData;

// the page's tokens for a mode: light or black over dark, an unknown mode dark's
export const tokens = (mode: string): Tokens =>
  mode === "light" || mode === "black" ? { ...data.dark, ...data[mode] } : { ...data.dark };

// the code window's tokens, in the page's own
export const ide = (): Tokens => ({ ...data.ide });

// the theme as rules: dark on the root, light and black by data-theme, the code window's under them
export function css(): string {
  let b = "/* generated from packages/core/theme/theme.json by the web build */\n";
  const rule = (sel: string, t: Tokens) => {
    const keys = Object.keys(t).sort();
    if (keys.length) b += `${sel} {${keys.map((k) => ` ${k}: ${t[k]};`).join("")} }\n`;
  };
  rule(":root", data.dark);
  rule(':root[data-theme="light"]', data.light);
  rule(':root[data-theme="black"]', data.black);
  rule(".ide-win", data.ide);
  return b;
}
