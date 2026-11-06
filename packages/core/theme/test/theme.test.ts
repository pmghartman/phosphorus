import { expect, test } from "bun:test";
import { css, ide, MODES, tokens } from "@phosphorus/theme";

test("tokens", () => {
  for (const mode of MODES) {
    const tk = tokens(mode);
    for (const k of ["--bg", "--fg", "--accent", "--border", "--font", "--mono", "--desk", "--r-win"])
      expect(tk[k]).toBeTruthy();
  }
  expect(ide()["--ide-bg"]).toBeTruthy();
});

test("layers", () => {
  expect(tokens("light")["--bg"]).toBe("#ffffff");
  expect(tokens("light")["color-scheme"]).toBe("light");
  expect(tokens("black")["--bg"]).toBe("#000000");
  // black keeps dark's text and accent
  expect(tokens("black")["--fg"]).toBe(tokens("dark")["--fg"]!);
  expect(tokens("nope")["--bg"]).toBe(tokens("dark")["--bg"]!);
});

test("css", () => {
  const out = css();
  for (const want of [":root {", ':root[data-theme="light"] {', ':root[data-theme="black"] {', ".ide-win {"])
    expect(out).toContain(want);
  expect(out).not.toContain("data-palette");
});
