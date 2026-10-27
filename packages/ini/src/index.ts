// phosphorus.ini read as util.js did: first key wins, quotes stripped, ; and #
// comment lines, re-parsed only on a stat change
import { readFileSync, statSync } from "node:fs";

const commentRe = /^\s*[;#]/;
const headRe = /^\s*\[\s*(.+?)\s*\]\s*$/;
const kvRe = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/;

// "section\0key" to value, the first occurrence kept
export function parse(text: string): Map<string, string> {
  const keys = new Map<string, string>();
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    if (commentRe.test(line)) continue;
    const h = headRe.exec(line);
    if (h) {
      current = h[1]!;
      continue;
    }
    const m = kvRe.exec(line);
    if (!m) continue;
    const k = current + "\0" + m[1];
    if (!keys.has(k)) keys.set(k, m[2]!.replace(/^"|"$/g, ""));
  }
  return keys;
}

// one ini file, cached by its stat signature
export class IniFile {
  private sig = "";
  private keys?: Map<string, string>;
  constructor(public path: string) {}

  // one key, blank when unset or the file is unreadable
  get(section: string, key: string): string {
    let sig: string;
    try {
      const st = statSync(this.path, { bigint: true });
      sig = `${st.ino}:${st.size}:${st.mtimeNs}`;
    } catch {
      return "";
    }
    if (sig !== this.sig || !this.keys) {
      let text = "";
      try {
        text = readFileSync(this.path, "utf8");
      } catch {}
      this.keys = parse(text);
      this.sig = sig;
    }
    return this.keys.get(section + "\0" + key) ?? "";
  }
}
