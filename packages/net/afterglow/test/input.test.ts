// the viewer's input as afterglow's input packets (host/src/input.rs reads them): their
// bytes, the keys as US-layout virtual keys, text where the viewer's layout differs,
// and what the packer makes of the viewer's messages

import { describe, expect, test } from "bun:test";
import { asText, InputPacker, pack, vkOf } from "../src/index.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("input packets", () => {
  test("absolute mouse: big-endian, the far edge as width-1", () => {
    expect(hex(pack.mouseAbs(0x05b8, 0x0210, 1920, 1080))).toBe(
      "0000000e" + "05000000" + "05b8" + "0210" + "0000" + "077f" + "0437",
    );
  });
  test("relative mouse", () => {
    expect(hex(pack.mouseRel(-1, 0))).toBe("0000000807000000ffff0000");
  });
  test("buttons", () => {
    expect(hex(pack.button(true, 1))).toBe("0000000508000000" + "01");
    expect(hex(pack.button(false, 3))).toBe("0000000509000000" + "03");
  });
  test("keys: the virtual key with its high bit, the modifiers", () => {
    expect(hex(pack.key(true, 0xa4, 0x04))).toBe("0000000a03000000" + "00a480040000");
    expect(hex(pack.key(false, 0x41, 0))).toBe("0000000a04000000" + "004180000000");
  });
  test("scroll, one notch down; horizontal", () => {
    expect(hex(pack.scroll(-120))).toBe("0000000a0a000000" + "ff88ff880000");
    expect(hex(pack.hscroll(30))).toBe("000000060100005500" + "1e");
  });
  test("text, any length in one packet", () => {
    expect(hex(pack.utf8("hé"))).toBe("0000000717000000" + "68c3a9");
    expect(pack.utf8("é".repeat(100)).length).toBe(8 + 200);
  });
});

describe("keys", () => {
  test("virtual keys, US layout", () => {
    expect(vkOf("KeyA")).toBe(0x41);
    expect(vkOf("Digit0")).toBe(0x30);
    expect(vkOf("F12")).toBe(0x7b);
    expect(vkOf("ShiftRight")).toBe(0xa1);
    expect(vkOf("Numpad5")).toBe(0x65);
    expect(vkOf("Quote")).toBe(0xde);
    expect(vkOf("Nope")).toBe(0);
  });
  test("text when the viewer's layout differs on that key", () => {
    expect(asText("KeyA", "a", false, false)).toBe(false);
    expect(asText("KeyA", "A", false, true)).toBe(false);
    expect(asText("Digit2", "@", false, true)).toBe(false);
    // AZERTY: the key US calls Q types a; German: Digit2 shifted is "
    expect(asText("KeyQ", "a", false, false)).toBe(true);
    expect(asText("Digit2", '"', false, true)).toBe(true);
    expect(asText("Digit2", "é", false, false)).toBe(true);
    // shortcuts and named keys stay keys
    expect(asText("KeyQ", "a", true, false)).toBe(false);
    expect(asText("Enter", "Enter", false, false)).toBe(false);
  });
});

describe("the packer", () => {
  test("a key typed in another layout goes as text, its key-up dropped; a paste is typed", () => {
    const out: string[] = [];
    const p = new InputPacker((b) => out.push(hex(b)));
    p.input(["k", true, "KeyQ", "a", false], 100, 100);
    p.input(["k", false, "KeyQ", "a", false], 100, 100);
    expect(out).toEqual([hex(pack.utf8("a"))]);
    out.length = 0;
    p.input(["clip", "pasted"], 100, 100);
    p.input(["k", true, "ControlLeft", "Control", false], 100, 100);
    p.input(["k", true, "KeyV", "v", true], 100, 100);
    // ctrl let go, the clipboard typed
    expect(out).toEqual([hex(pack.key(true, 0xa2, 0x02)), hex(pack.key(false, 0xa2, 0)), hex(pack.utf8("pasted"))]);
  });
  test("the mouse kept on the video, wheels in notches", () => {
    const out: Uint8Array[] = [];
    const p = new InputPacker((b) => out.push(b));
    p.input(["m", 5000, -3], 1280, 720);
    p.input(["w", 0, 1], 1280, 720);
    expect(hex(out[0]!)).toBe(hex(pack.mouseAbs(1279, 0, 1280, 720)));
    expect(hex(out[1]!)).toBe(hex(pack.scroll(-120)));
  });
});
