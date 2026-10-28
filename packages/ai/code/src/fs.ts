// a host's folders over the user's own ssh login: a listing for the page's
// picker and browser, files uploaded in without overwriting; sh -c with the
// paths as its arguments, never spliced into the script
import { posix } from "node:path";
import { errText } from "@phosphorus/util";
import { errB, hostRe, type Res } from "./harness.ts";
import { type Creds, quote } from "./script.ts";
import { capture, dial, type Stdin } from "./ssh.ts";
import { lastLine } from "./text.ts";

// lsMax entries a listing holds, the rest only counted as more
const lsMax = 2000;
// lsOut a listing's output kept at most
const lsOut = 4 << 20;
// UploadMax one upload's bytes
export const UploadMax = 50 << 20;
// dupMax "name (n).ext" tried up to n
const dupMax = 99;
export const dirMax = 1024;

// Entry one name in a listing
export type Entry = { name: string; dir: boolean; size: number; mtime: number };

// dirPrelude $1 as a folder: "" and ~ its home, ~/x under it; then cd'd
// into, exit 3 when it can't be
const dirPrelude =
  `d=$1; shift; case $d in "" | "~") d=$HOME ;; "~/"*) d=$HOME/\${d#"~/"} ;; esac; ` +
  `cd -- "$d" 2>/dev/null || exit 3; `;

// lsCommand a listing of dir: its resolved path, then each name tagged d or
// f, NUL ended, an empty one closing them; then lstat's size and mtime, a line
// per name in the same order, GNU's stat or BSD's
export function lsCommand(dir: string): string {
  const script =
    dirPrelude +
    `printf '%s\\000' "$(pwd -P)"; n=0; more=; ` +
    `for f in .[!.]* ..?* *; do [ -e "$f" ] || [ -L "$f" ] || continue; n=$((n+1)); ` +
    `if [ $n -gt ${lsMax} ]; then more=1; break; fi; set -- "$@" "$f"; done; ` +
    `for f in "$@"; do if [ -d "$f" ]; then printf 'd%s\\000' "$f"; else printf 'f%s\\000' "$f"; fi; done; ` +
    `printf '%s\\000' "$more"; [ $# -eq 0 ] && exit 0; ` +
    `stat -c '%s %Y' -- "$@" 2>/dev/null || stat -f '%z %m' -- "$@" 2>/dev/null; exit 0`;
  return "sh -c " + quote(script) + " sh " + quote(dir);
}

const utf8 = (b: Uint8Array) => Buffer.from(b).toString();

// parseLs lsCommand's output: the folder, its entries folders first, whether
// there were more
export function parseLs(out: Uint8Array): { dir: string; entries: Entry[]; more: boolean } {
  const parts: Uint8Array[] = [];
  for (let i = 0, j; i <= out.length; i = j + 1) {
    j = out.indexOf(0, i);
    if (j < 0) j = out.length;
    parts.push(out.subarray(i, j));
  }
  if (parts.length < 3 || !parts[0]!.length || parts[0]![0] !== 0x2f) throw new Error("unreadable listing");
  const dir = utf8(parts[0]!);
  const entries: Entry[] = [];
  let i = 1;
  for (; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 2 || (p[0] !== 0x64 && p[0] !== 0x66)) break;
    entries.push({ name: utf8(p.subarray(1)), dir: p[0] === 0x64, size: 0, mtime: 0 });
  }
  if (i >= parts.length) throw new Error("unreadable listing");
  const more = parts[i]!.length > 0;
  // the stat lines, kept only when there's one per name
  const rest = utf8(Buffer.concat(parts.slice(i + 1))).trim();
  const lines = rest.split("\n");
  if (rest && lines.length === entries.length)
    lines.forEach((l, k) => {
      const f = l.split(/\s+/).filter(Boolean);
      if (f.length !== 2) return;
      entries[k]!.size = int(f[0]!);
      const m = f[1]!;
      if (/^-?\d+$/.test(m)) entries[k]!.mtime = int(m) * 1000;
    });
  entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const x = a.name.toLowerCase(),
      y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { dir, entries, more };
}

const int = (s: string) => (/^-?\d+$/.test(s) ? Number(s) : 0);

// uploadCommand stdin written into dir under the first of the names that
// isn't there yet, made with noclobber so nothing's overwritten; its path
// printed, the file gone again when it isn't size bytes
export function uploadCommand(dir: string, size: number, names: string[]): string {
  const script =
    dirPrelude +
    `n=$1; shift; for f in "$@"; do ` +
    `if (set -C; : > "$f") 2>/dev/null; then cat > "$f" || { rm -f -- "$f"; exit 5; }; ` +
    `if [ "$(wc -c < "$f" | tr -d ' ')" != "$n" ]; then rm -f -- "$f"; exit 5; fi; ` +
    `printf '%s/%s' "$(pwd -P)" "$f"; exit 0; fi; done; exit 4`;
  return "sh -c " + quote(script) + " sh " + [quote(dir), String(size), ...names.map(quote)].join(" ");
}

// dupNames name, then "name (1).ext" on to "name (n).ext"
export function dupNames(name: string, n: number): string[] {
  let stem = name,
    ext = "";
  const i = name.lastIndexOf(".");
  if (i > 0) [stem, ext] = [name.slice(0, i), name.slice(i)];
  const out = [name];
  for (let k = 1; k <= n; k++) out.push(`${stem} (${k})${ext}`);
  return out;
}

// okName a file name as uploaded: no slash, no control character, not . or ..
export function okName(n: string): boolean {
  if (n === "" || n === "." || n === ".." || Buffer.byteLength(n) > 255 || n.includes("/")) return false;
  return !/[\p{Cc}]/u.test(n);
}

// okDir a folder as asked: absolute, or ~ and under it
export function okDir(d: string): boolean {
  if (d.length > dirMax || /[\0\r\n]/.test(d)) return false;
  return d === "" || d === "~" || d.startsWith("~/") || d.startsWith("/");
}

// shellErr a host's shell refusing sh, a Windows one named
export function shellErr(host: string, code: number, errs: string): string {
  const low = errs.toLowerCase();
  if (low.includes("not recognized") || low.includes("commandnotfound"))
    return `${host} runs Windows, which Code doesn't support yet`;
  if (!errs) return `on ${host}: exit ${code}`;
  return `on ${host}: ${lastLine(errs)}`;
}

// ls a folder on host as the login: dir "" or ~ its home
export async function ls(host: string, dir: string, c: Creds): Promise<Res> {
  if (!hostRe.test(host)) return [400, errB("pick a host")];
  if (!okDir(dir)) return [400, errB("dir: an absolute path, or ~")];
  let cl;
  try {
    cl = await dial(host, c.user, c.pass);
  } catch (e) {
    return [502, errB(errText(e))];
  }
  try {
    const r = await capture(cl, lsCommand(dir), undefined, lsOut, 30_000);
    if (r.error) return [502, errB(r.error)];
    if (r.code === 3) return [404, errB(`can't open ${dir} on ${host}`)];
    if (r.code !== 0) return [502, errB(shellErr(host, r.code, r.errs))];
    try {
      return [200, parseLs(r.out)];
    } catch {
      return [502, errB(shellErr(host, r.code, r.errs))];
    }
  } finally {
    cl.end();
  }
}

// upload size bytes of body into dir on host as the login, under name or
// "name (n).ext" when that's taken
export async function upload(
  host: string,
  dir: string,
  name: string,
  size: number,
  body: Stdin,
  c: Creds,
): Promise<Res> {
  name = name.trim();
  if (!hostRe.test(host)) return [400, errB("pick a host")];
  if (!okDir(dir)) return [400, errB("dir: an absolute path, or ~")];
  if (!okName(name)) return [400, errB("name: a file name")];
  if (!Number.isInteger(size) || size < 0) return [411, errB("send the length")];
  if (size > UploadMax) return [413, errB("50MB at most")];
  let cl;
  try {
    cl = await dial(host, c.user, c.pass);
  } catch (e) {
    return [502, errB(errText(e))];
  }
  try {
    const r = await capture(
      cl,
      uploadCommand(dir, size, dupNames(name, dupMax)),
      body ?? "",
      64 * 1024,
      10 * 60_000,
      size,
    );
    if (r.error) return [502, errB(r.error)];
    if (r.code === 3) return [404, errB(`can't open ${dir} on ${host}`)];
    if (r.code === 4) return [409, errB("too many files named " + name + " there already")];
    if (r.code === 5) return [502, errB("the upload was cut short")];
    if (r.code !== 0) return [502, errB(shellErr(host, r.code, r.errs))];
    const p = utf8(r.out);
    if (!p.startsWith("/")) return [502, errB(shellErr(host, r.code, r.errs))];
    return [200, { path: posix.normalize(p).replace(/(.)\/+$/, "$1") }];
  } finally {
    cl.end();
  }
}
