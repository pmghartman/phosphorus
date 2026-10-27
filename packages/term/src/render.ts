// a session's kept output replayed through a vt emulator at the tab's size,
// the screen and the scrollback above it as plain lines
import { Terminal } from "@xterm/headless";

// screenLines how much a snapshot keeps: the rows and the scrollback above them
export const screenLines = 120;

// render chunks as a cols by rows terminal saw them, trailing blank lines dropped
export async function render(chunks: Uint8Array[], cols: number, rows: number): Promise<string> {
  const e = new Terminal({ cols, rows, scrollback: screenLines, logLevel: "off", allowProposedApi: true });
  const all = Buffer.concat(chunks);
  if (all.length) await new Promise<void>((r) => e.write(all, r));
  const b = e.buffer.active;
  let lines: string[] = [];
  for (let y = 0; y < b.length; y++) {
    const l = b.getLine(y);
    let s = "";
    for (let x = 0; x < cols; x++) {
      const c = l?.getCell(x);
      // a wide glyph's second cell: nothing; an empty one: a space
      s += !c ? " " : c.getWidth() === 0 ? "" : c.getChars() || " ";
    }
    lines.push(s.replace(/ +$/, ""));
  }
  e.dispose();
  if (lines.length > screenLines) lines = lines.slice(-screenLines);
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.join("\n");
}
