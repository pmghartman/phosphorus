import { expect, test } from "bun:test";
import { Default, load } from "@phosphorus/theme";

test("library", () => {
  const l = load();
  const seen = new Set<string>();
  for (const th of l.themes) {
    expect(th.id && th.label && th.look && !seen.has(th.id)).toBeTruthy();
    seen.add(th.id);
    for (const mode of ["dark", "light", "oled"]) {
      const tk = l.tokens(th.id, mode);
      for (const k of ["--bg", "--fg", "--accent", "--border", "--font", "--mono"]) expect(tk[k]).toBeTruthy();
      expect(l.ide(th.id, mode)["--ide-bg"]).toBeTruthy();
    }
    expect(th.icons).toBeTruthy();
  }
  expect(seen.has(Default)).toBe(true);
});

test("layers", () => {
  const l = load();
  // light over the theme's dark, the base's light under the theme's own
  expect(l.tokens("vscode", "light")["--bg"]).toBe("#ffffff");
  expect(l.tokens("vscode", "oled")["--bg"]).toBe("#000000");
  expect(l.tokens("nope", "dark")["--bg"]).toBe(l.tokens(Default, "dark")["--bg"]!);
});

test("layout", () => {
  const l = load();
  const m = l.layout("macos");
  expect([m.btnStyle, m.menubar, m.bar]).toEqual(["lights", "top", "bottom"]);
  expect(m.items?.length).toBeGreaterThan(0);
  const d = l.layout(Default);
  expect([d.barStyle, d.btns]).toEqual(["panel", "right"]);
});

test("css", () => {
  const css = load().css();
  for (const want of [
    `:root:where([data-palette="phosphorus"], :not([data-palette])) {`,
    `:root:where([data-palette="macos"][data-theme="light"]) {`,
    `:where(:root:where([data-palette="win11"][data-theme="oled"])) .ide-win {`,
    `:where(:root:where([data-palette="macos"])) .dk-app-code .dk-body {`,
  ])
    expect(css).toContain(want);
});
