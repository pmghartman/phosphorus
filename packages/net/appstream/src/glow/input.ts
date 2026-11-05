// the viewer's input as GameStream input packets: what glow sends over its control
// stream to a Sunshine or Apollo, and what afterglow takes on its local link, both
// handing them to the host's own input code as they are. Keys go as US-layout
// virtual keys, or as text where the viewer's layout differs so it wins; a paste is
// the page's clipboard typed

import { Channel, pack } from "./spark.ts";
import { asText, modOf, utf8Chunks, vkOf } from "./vk.ts";

// GameStream's mouse buttons: X's 8 and 9 are its 4 and 5
const buttons: Record<number, number> = { 1: 1, 2: 2, 3: 3, 8: 4, 9: 5 };
const clamp = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

// one packet out, on the channel its kind takes (a link with one channel ignores it)
export type Send = (channel: number, pkt: Uint8Array) => void;

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
    this.send(Channel.keyboard, pack.key(down, v, this.mods));
  }

  private text(s: string) {
    for (const c of utf8Chunks(s)) this.send(Channel.utf8, pack.utf8(c));
  }

  // one input message from the viewer; sw, sh the video's size
  input(m: unknown[], sw: number, sh: number) {
    switch (m[0]) {
      case "m":
        return this.send(Channel.mouse, pack.mouseAbs(clamp(m[1], 0, sw - 1), clamp(m[2], 0, sh - 1), sw, sh));
      case "b": {
        const b = buttons[clamp(m[1], 1, 9)];
        if (b) this.send(Channel.mouse, pack.button(!!m[2], b));
        return;
      }
      case "w": {
        const dx = clamp(m[1], -20, 20);
        const dy = clamp(m[2], -20, 20);
        if (dy) this.send(Channel.mouse, pack.scroll(-dy * 120));
        if (dx) this.send(Channel.mouse, pack.hscroll(dx * 120));
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
