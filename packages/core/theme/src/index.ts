// phosphorus's theme library: every color, font, shadow and corner token of every
// theme, in themes.json, the one source the desktop, the terminals, the cli and the
// tray all draw from. The web build turns it into CSS (css); callers resolve a
// theme's tokens for a mode (tokens)
import raw from "../themes.json" with { type: "json" };

// a theme's custom properties ("--bg") and the odd plain property ("color-scheme")
export type Tokens = Record<string, string>;
// a set of tokens by light or dark: oled and light each lay over dark
export type Modes = { dark?: Tokens; light?: Tokens; oled?: Tokens };
// where the desktop's bars sit and how windows wear their chrome; empty fields the base's
export type Layout = {
  bar?: string; // bottom, top, left, right
  barStyle?: string; // panel, dock, full, line
  menubar?: string; // off, top, bottom
  items?: string[]; // status items shown, in order
  btns?: string; // left, right
  btnStyle?: string; // glyphs, lights, caption
  title?: string; // left, center
  density?: string; // compact, normal, roomy
  autohide?: string; // off, on: the bar tucked away until its edge is reached
  labels?: string; // both, icons, titles: what the bar's windows and the menu bar's app show
};
// one entry: look names the page's structural styles, icons its icon set
// (web/src/icons/), layout its bars and window chrome, round and sans mark rounded
// controls and a proportional page font, scopes tokens for a part of the page alone
export type Theme = {
  id: string;
  label: string;
  about?: string;
  look: string;
  icons?: string;
  layout?: Layout;
  round?: boolean;
  sans?: boolean;
  dark?: Tokens;
  light?: Tokens;
  oled?: Tokens;
  ide?: Modes;
  scopes?: Record<string, Modes>;
};
// the whole file: the base every theme lays over, then the themes in their order
export type LibraryData = { base: { layout: Layout; dark: Tokens; light: Tokens; oled: Tokens; ide: Modes }; themes: Theme[] };

// the theme a page or tool starts on
export const Default = "phosphorus";

const merge = (...sets: (Tokens | undefined)[]): Tokens => Object.assign({}, ...sets.filter(Boolean));

export class Library {
  constructor(public data: LibraryData) {}
  get themes() {
    return this.data.themes;
  }

  // a theme by id, the default's for an unknown one
  get(id: string): Theme {
    const t = this.themes;
    return t.find((x) => x.id === id) ?? t.find((x) => x.id === Default) ?? t[0]!;
  }

  // a theme's page tokens for "dark", "light" or "oled": its dark over the base's,
  // then for light or oled the base's and its own of that mode over those
  tokens(id: string, mode: string): Tokens {
    const t = this.get(id), b = this.data.base;
    if (mode === "light") return merge(b.dark, t.dark, b.light, t.light);
    if (mode === "oled") return merge(b.dark, t.dark, b.oled, t.oled);
    return merge(b.dark, t.dark);
  }

  // a theme's workbench tokens for a mode, laid over the base's as the page's are
  ide(id: string, mode: string): Tokens {
    const t = this.get(id).ide ?? {}, b = this.data.base.ide;
    if (mode === "light") return merge(b.dark, b.light, t.dark, t.light);
    if (mode === "oled") return merge(b.dark, b.oled, t.dark, t.oled);
    return merge(b.dark, t.dark);
  }

  // a theme's layout, its own fields over the base's
  layout(id: string): Layout {
    const o: Layout = { ...this.data.base.layout };
    for (const [k, v] of Object.entries(this.get(id).layout ?? {})) if (v !== "" && v != null) (o as any)[k] = v;
    return o;
  }

  // every theme's tokens as rules: each theme's under its data-palette, light and
  // oled by data-theme, all at a single class's weight (:where) so a custom theme's
  // overrides win; the default's also when no theme is set yet
  css(): string {
    let b = "/* generated from packages/theme/themes.json by the web build */\n";
    const rule = (sel: string, t: Tokens) => {
      const keys = Object.keys(t).sort();
      if (keys.length) b += `${sel} {${keys.map((k) => ` ${k}: ${t[k]};`).join("")} }\n`;
    };
    for (const t of this.themes) {
      for (const mode of ["dark", "light", "oled"]) {
        const m = mode !== "dark" ? `[data-theme="${mode}"]` : "";
        let on = `[data-palette="${t.id}"]${m}`;
        if (t.id === Default) on += `, :not([data-palette])${m}`;
        rule(`:root:where(${on})`, this.tokens(t.id, mode));
        rule(`:where(:root:where(${on})) .ide-win`, this.ide(t.id, mode));
        for (const s of Object.keys(t.scopes ?? {}).sort()) rule(`:where(:root:where(${on})) ${s}`, scope(t.scopes![s]!, mode));
      }
    }
    return b;
  }
}

function scope(m: Modes, mode: string): Tokens {
  if (mode === "light") return merge(m.dark, m.light);
  if (mode === "oled") return merge(m.dark, m.oled);
  return m.dark ?? {};
}

let lib: Library | undefined;
// the library, parsed once
export const load = () => (lib ??= new Library(raw as unknown as LibraryData));
// the library's data as the file holds it, for the page's own pick
export const library = (): LibraryData => raw as unknown as LibraryData;
