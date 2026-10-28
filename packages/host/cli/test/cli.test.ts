import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-cli-"));
process.env.PHOSPHORUS_CONFIG_DIR = dir;
// proxy's domain is fixed on its first import: the one its own test expects
process.env.BASE_DOMAIN ??= "mulab.dev";
const svc = join(dir, "services.export"), ini = join(dir, "phosphorus.ini");
const draw = await import("../src/draw.ts");
const { Parser } = await import("../src/input.ts");
const { num, str, get, objs } = await import("../src/json.ts");
const { ago, clampSel } = await import("../src/views.ts");

test("json read loosely", () => {
  expect(str(null)).toBe("");
  expect(str(3)).toBe("3");
  expect(str(1.5)).toBe("1.5");
  expect(str(true)).toBe("true");
  expect(num(" 12 ")).toBe(12);
  expect(num("x")).toBe(0);
  expect(num(true)).toBe(1);
  expect(get({ a: { b: 1 } }, "a", "b")).toBe(1);
  expect(get({ a: [1] }, "a", "b")).toBeUndefined();
  expect(objs([{ a: 1 }, 2, null])).toEqual([{ a: 1 }]);
});

test("text measured past its codes, cut, padded and wrapped", () => {
  const { vlen, pad, cut, wrap, mix, hexOf, to256, rgb, c } = draw;
  expect(vlen("\x1b[38;5;1mé\x1b[0m")).toBe(1);
  expect(pad("ab", 4)).toBe("ab  ");
  expect(cut("\x1b[1mhello\x1b[22m", 3)).toBe("\x1b[1mhel\x1b[22m");
  expect(wrap("short", 10, 0)).toEqual(["short"]);
  expect(wrap("one two three", 7, 0)).toEqual(["one two", "three"]);
  expect(wrap("one two three", 7, 2)).toEqual(["one two", "  three"]);
  // a long path broken after its separators, codes carried onto the next line
  expect(wrap("/srv/data/files", 9, 0)).toEqual(["/srv/", "data/", "files"]);
  expect(wrap("\x1b[1mabcdefghij\x1b[22m", 4, 0)).toEqual(["\x1b[1mabcd", "\x1b[1mefgh", "\x1b[1mij\x1b[22m"]);
  expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  expect(hexOf([0, 128, 255])).toBe("#0080ff");
  expect(rgb("#0080ff")).toEqual([0, 128, 255]);
  expect(to256([0, 0, 0])).toBe(16);
  expect(to256([255, 255, 255])).toBe(231);
  expect(to256([128, 128, 128])).toBe(244);
  expect(c("accent")("x")).toMatch(/^\x1b\[38;(2;\d+;\d+;\d+|5;\d+)mx\x1b\[38;/);
  draw.setTheme(false);
  expect(draw.base.startsWith("\x1b[0m\x1b[49m\x1b[38;")).toBe(true);
  expect(draw.fit("abc", 2)).toBe("ab" + draw.base);
});

test("tables and panels", () => {
  const { table, panel, panels, vlen, selMark } = draw;
  const t = table(["name", "port"], [["web", "8080"], ["mc", "1"]], 1, 0);
  expect(t.length).toBe(3);
  expect(t[0]!.sel).toBeUndefined();
  expect(vlen(t[0]!.text)).toBe("  name  port".length);
  expect(t[1]!.text.replace(/\x1b\[[0-9;]*m/g, "")).toBe("  web   8080");
  expect(t[2]!.text.replace(/\x1b\[[0-9;]*m/g, "")).toBe("› mc    1   ");
  expect(t[2]!.sel).toBe(true);
  // past max: a window around the selection and a count
  const big = table(["n"], Array.from({ length: 10 }, (_, i) => [String(i)]), 7, 4);
  expect(big.length).toBe(5);
  expect(big[1]!.text.replace(/\x1b\[[0-9;]*m/g, "")).toBe("  6");
  expect(big[4]!.text.replace(/\x1b\[[0-9;]*m/g, "")).toBe("  7-9 of 10");
  const p = panel("t", [{ text: "a" }, { text: "b", sel: true }], 4);
  expect(p.length).toBe(4);
  expect(p[2]!.startsWith(selMark)).toBe(true);
  expect(p[1]!.replace(/\x1b\[[0-9;]*m/g, "")).toBe("│ a    │");
  expect(p[3]!.replace(/\x1b\[[0-9;]*m/g, "")).toBe("└──────┘");
  expect(panels(undefined, { title: "x", lines: [] }, { title: "", lines: [] }).filter((l) => l === "").length).toBe(1);
  expect(ago(59)).toBe("59s");
  expect(ago(3600)).toBe("1h");
  expect(ago(90000)).toBe("1d");
  expect(clampSel(5, 3)).toBe(2);
  expect(clampSel(-1, 0)).toBe(0);
});

test("stdin parsed into readline's key events", () => {
  const p = new Parser();
  const names = (s: string) => p.feed(s).map((e) => [e.name, e.str, e.ctrl, e.shift, e.meta]);
  expect(names("aA ")).toEqual([["a", "a", false, false, false], ["a", "A", false, true, false], ["space", " ", false, false, false]]);
  expect(names("\r\n\t\x7f\x03")).toEqual([["return", "\r", false, false, false], ["enter", "\n", false, false, false], ["tab", "\t", false, false, false], ["backspace", "\x7f", false, false, false], ["c", "\x03", true, false, false]]);
  expect(names("\x1b[A\x1b[1;2C\x1b[Z\x1b[5~\x1b[6~\x1b[3~\x1bOB")).toEqual([
    ["up", "", false, false, false], ["right", "", false, true, false], ["tab", "", false, true, false],
    ["pageup", "", false, false, false], ["pagedown", "", false, false, false], ["delete", "", false, false, false], ["down", "", false, false, false],
  ]);
  expect(names("\x1b")).toEqual([["escape", "", false, false, false]]);
  expect(names("\x1b\x1bx")).toEqual([["escape", "", false, false, false], ["x", "x", false, false, true]]);
  expect(names("é😀")).toEqual([["é", "é", false, false, false], ["😀", "😀", false, false, false]]);
  // an unfinished sequence waits for the rest
  expect(names("\x1b[")).toEqual([]);
  expect(names("B")).toEqual([["down", "", false, false, false]]);
  // a paste whole, its end marker split across reads
  expect(names("\x1b[200~hi\nthere\x1b[20")).toEqual([]);
  expect(names("1~q")).toEqual([["paste", "hi\nthere", false, false, false], ["q", "q", false, false, false]]);
});
