// a services.export's text as rows: what each host kept before its pages were
// records in the store, read once to move them there and to check a record's fields
import { type Row, rowError } from "@phosphorus/proxy";

// a web service's port, scheme (blank: sniffed), max_body, public, and aliases: more
// names it answers at, comma separated
export const Keys = ["port", "scheme", "max_body", "public", "aliases"];
// older keys still read: mode is picked (a subdomain once *.<domain> answers,
// settled across hosts), base_path is gone, extras' max_body is a key of its own
const oldKeys = ["mode", "base_path", "extras"];
const extraKeys = ["flush_interval", "max_body", "forwarded_proto"];
// a game server's, from before Games was an app: its section left for the app
const gameKeys = ["type", "start", "stop"];
export const headRe = /^\[\s*(.*?)\s*\]$/;
const commentRe = /^[#;]/;
const digitsRe = /^[0-9]+$/;
const quoteRe = /^"|"$/g;

type Section = { name: string; f: Map<string, string> };

// every section as a declared row, or the first reason to reject; old keys
// still read listed as "[name] key", a game's section skipped
export function parse(text: string): [Row[], string, string[]] {
  const sections: Section[] = [];
  let cur: Section | undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "").trim();
    if (!line || commentRe.test(line)) continue;
    const m = headRe.exec(line);
    if (m) {
      sections.push((cur = { name: m[1]!, f: new Map() }));
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) return [[], `line ${i + 1} is not key = value`, []];
    const key = line.slice(0, eq).trim();
    if (!cur) return [[], `line ${i + 1}: ${key} outside any [section]`, []];
    if (!Keys.includes(key) && !oldKeys.includes(key) && !gameKeys.includes(key))
      return [[], `[${cur.name}] has an unknown key, ${key}`, []];
    cur.f.set(
      key,
      line
        .slice(eq + 1)
        .trim()
        .replace(quoteRe, ""),
    );
  }
  const rows: Row[] = [];
  const old: string[] = [];
  const names = new Set<string>();
  for (const s of sections) {
    const no = (why: string): [Row[], string, string[]] => [[], `[${s.name}] ${why}`, []];
    if (names.has(s.name)) return no("is declared twice");
    names.add(s.name);
    if (s.f.get("type") === "game") continue;
    const stray = gameKeys.find((k) => s.f.has(k));
    if (stray) return no(`has an unknown key, ${stray}`);
    for (const k of oldKeys) if (s.f.has(k)) old.push(`[${s.name}] ${k}`);
    if (!s.f.has("port")) return no("has no port");
    let port: unknown = s.f.get("port");
    if (digitsRe.test(s.f.get("port")!)) port = Number(s.f.get("port"));
    let maxBody: unknown = s.f.get("max_body") || undefined;
    if (s.f.has("extras")) {
      let extras: unknown;
      try {
        extras = JSON.parse(s.f.get("extras") || "{}");
      } catch {
        return no("extras is not valid JSON");
      }
      if (!extras || typeof extras !== "object" || Array.isArray(extras)) return no("extras is not a JSON object");
      for (const k of Object.keys(extras)) if (!extraKeys.includes(k)) return no(`extras has an unknown key, ${k}`);
      maxBody ??= (extras as Row).max_body;
    }
    // a blank scheme sniffed when published
    const row: Row = { name: s.name, port, scheme: s.f.get("scheme") || "" };
    if (maxBody !== undefined) row.max_body = maxBody;
    if (s.f.has("public")) {
      const p = s.f.get("public")!;
      row.public = p === "true" || p === "false" ? p === "true" : p;
    }
    const al = (s.f.get("aliases") ?? "").split(/[\s,]+/).filter(Boolean);
    if (al.length) row.aliases = al;
    const why = rowError({ ...row, scheme: row.scheme || "http", mode: "path" });
    if (why) return no(why);
    rows.push(row);
  }
  return [rows, "", old];
}
