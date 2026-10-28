// stdin parsed into node readline's key events, a bracketed paste whole

// KeyEv as node's readline names it, a paste whole as name paste
export type KeyEv = { name: string; str: string; ctrl: boolean; shift: boolean; meta: boolean };

const ev = (e: Partial<KeyEv>): KeyEv => ({ name: "", str: "", ctrl: false, shift: false, meta: false, ...e });

const pasteStart = "\x1b[200~";
const pasteEnd = "\x1b[201~";
const csiRe = /^\x1b(\[|O)([0-9;]*)([A-Za-z~])/;

// the first code point and how many code units it takes
const firstRune = (s: string): [string, number] => {
  const r = String.fromCodePoint(s.codePointAt(0)!);
  return [r, r.length];
};

export class Parser {
  buf = "";
  pasting = false;
  paste = "";

  feed(s: string): KeyEv[] {
    this.buf += s;
    const out: KeyEv[] = [];
    while (this.buf !== "") {
      if (this.pasting) {
        const i = this.buf.indexOf(pasteEnd);
        if (i < 0) {
          // a split end marker left for the next read
          let keep = 0;
          for (let n = pasteEnd.length - 1; n > 0; n--) {
            if (this.buf.endsWith(pasteEnd.slice(0, n))) {
              keep = n;
              break;
            }
          }
          this.paste += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        this.paste += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + pasteEnd.length);
        this.pasting = false;
        out.push(ev({ name: "paste", str: this.paste }));
        this.paste = "";
        continue;
      }
      if (this.buf.startsWith(pasteStart)) {
        this.buf = this.buf.slice(pasteStart.length);
        this.pasting = true;
        continue;
      }
      const b = this.buf.charCodeAt(0);
      if (b === 0x1b) {
        if (this.buf.length === 1) {
          out.push(ev({ name: "escape" }));
          this.buf = "";
          continue;
        }
        const m = csiRe.exec(this.buf);
        if (m) {
          this.buf = this.buf.slice(m[0].length);
          const e = ev({ shift: m[2]!.endsWith(";2") });
          switch (m[3]) {
            case "A":
              e.name = "up";
              break;
            case "B":
              e.name = "down";
              break;
            case "C":
              e.name = "right";
              break;
            case "D":
              e.name = "left";
              break;
            case "Z":
              e.name = "tab";
              e.shift = true;
              break;
            case "~":
              switch (m[2]!.split(";", 1)[0]) {
                case "3":
                  e.name = "delete";
                  break;
                case "5":
                  e.name = "pageup";
                  break;
                case "6":
                  e.name = "pagedown";
                  break;
              }
          }
          out.push(e);
          continue;
        }
        const b1 = this.buf[1];
        if (b1 === "[" || b1 === "O") {
          // an unfinished sequence waits for the rest, junk dropped
          if (this.buf.length < 16) return out;
          this.buf = this.buf.slice(2);
          continue;
        }
        if (b1 === "\x1b") {
          out.push(ev({ name: "escape" }));
          this.buf = this.buf.slice(1);
          continue;
        }
        const [r, n] = firstRune(this.buf.slice(1));
        out.push(ev({ name: r.toLowerCase(), str: r, meta: true }));
        this.buf = this.buf.slice(1 + n);
        continue;
      }
      if (b === 0x0d || b === 0x0a || b === 0x09 || b === 0x7f || b === 0x08 || b < 0x20) {
        const ch = this.buf[0]!;
        this.buf = this.buf.slice(1);
        if (b === 0x0d) out.push(ev({ name: "return", str: "\r" }));
        else if (b === 0x0a) out.push(ev({ name: "enter", str: "\n" }));
        else if (b === 0x09) out.push(ev({ name: "tab", str: "\t" }));
        else if (b === 0x7f || b === 0x08) out.push(ev({ name: "backspace", str: ch }));
        else out.push(ev({ name: String.fromCharCode(0x60 + b), str: ch, ctrl: true }));
        continue;
      }
      const [r, n] = firstRune(this.buf);
      this.buf = this.buf.slice(n);
      const e = ev({ str: r, name: r.toLowerCase() });
      if (r === " ") e.name = "space";
      if (r !== r.toLowerCase()) e.shift = true;
      out.push(e);
    }
    return out;
  }
}
