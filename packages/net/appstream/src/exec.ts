// a desktop entry's Exec line as an argv, by the Desktop Entry spec's quoting:
// space-separated arguments, double quotes with \" \` \$ \\ escaped inside, field
// codes replaced or dropped. The agent runs the argv itself, no shell between

export type ExecCtx = { name: string; icon: string; path: string };

export function parseExec(exec: string, c: ExecCtx): string[] {
  const words: { s: string; quoted: boolean }[] = [];
  let cur = "";
  let quoted = false;
  let inQ = false;
  let started = false;
  for (let i = 0; i < exec.length; i++) {
    const ch = exec[i]!;
    if (inQ) {
      if (ch === "\\" && i + 1 < exec.length && '"`$\\'.includes(exec[i + 1]!)) cur += exec[++i];
      else if (ch === '"') inQ = false;
      else cur += ch;
      continue;
    }
    if (ch === '"') {
      inQ = quoted = started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (started) words.push({ s: cur, quoted });
      cur = "";
      quoted = started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (inQ) throw new Error("the Exec line has an unclosed quote");
  if (started) words.push({ s: cur, quoted });
  const argv: string[] = [];
  for (const w of words) {
    if (w.s === "%i") {
      if (c.icon) argv.push("--icon", c.icon);
      continue;
    }
    if (/^%[fFuUdDnNvm]$/.test(w.s)) continue;
    const s = w.s.replace(/%(.)/g, (_, k: string) => (k === "%" ? "%" : k === "c" ? c.name : k === "k" ? c.path : ""));
    if (s || w.quoted) argv.push(s);
  }
  if (!argv.length) throw new Error("the Exec line runs nothing");
  // env NAME=value cmd: kept as is, the agent's exec takes env's own argv
  return argv;
}
