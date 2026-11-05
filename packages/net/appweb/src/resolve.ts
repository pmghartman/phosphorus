// a host app's launcher followed to the program it starts, and whether that program is an
// Electron app phosphorus can serve: a shortcut's target, a Squirrel install's newest copy,
// a desktop entry's command or the Electron binary behind its launcher script

import type { Host } from "./pipe.ts";

export type Target = { exe: string; args: string[]; electron: boolean; name: string };

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const winScript = (path: string) => `
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(path)}'))
$exe = $p; $argz = ''
if ($p -match '\\.lnk$') { $s = (New-Object -ComObject WScript.Shell).CreateShortcut($p); $exe = $s.TargetPath; $argz = $s.Arguments }
if ((Split-Path $exe -Leaf) -ieq 'Update.exe' -and $argz -match '--processStart\\s+"?([^"\\s]+)') {
  $n = $Matches[1]
  $app = Get-ChildItem (Split-Path $exe) -Directory -Filter 'app-*' | Sort-Object { try { [version]($_.Name -replace '^app-','') } catch { [version]'0.0' } } -Descending | Select-Object -First 1
  if ($app) { $exe = Join-Path $app.FullName $n; $argz = '' }
}
$d = Split-Path $exe
$res = { param($r) (Test-Path (Join-Path $r 'resources\\app.asar')) -or (Test-Path (Join-Path $r 'resources\\app\\package.json')) }
$el = & $res $d
if (-not $el) { $el = [bool](Get-ChildItem $d -Directory -ErrorAction SilentlyContinue | Where-Object { & $res $_.FullName } | Select-Object -First 1) }
[Console]::Out.Write((@{ exe = $exe; args = $argz; electron = [bool]$el } | ConvertTo-Json -Compress))
`;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// the Electron binary a command reaches: itself, or one beside or above its launcher script
const linuxScript = (cmd: string) => `
b=$(command -v ${shq(cmd)} 2>/dev/null || printf %s ${shq(cmd)})
r=$(readlink -f "$b" 2>/dev/null || printf %s "$b")
el() { d=$(dirname "$1"); [ -f "$d/resources/app.asar" ] || [ -f "$d/resources/app/package.json" ]; }
bin() { [ -f "$1" ] && [ -x "$1" ] && [ "$(head -c 2 "$1")" != '#!' ]; }
if bin "$r" && el "$r"; then printf '%s' "$r"; exit 0; fi
d=$(dirname "$r")
for x in "$d" "$(dirname "$d")" "$(dirname "$(dirname "$d")")"; do
  for f in "$x"/*; do if bin "$f" && el "$f"; then printf '%s' "$f"; exit 0; fi; done
done
printf '%s' "$r"
`;

// a desktop entry's Exec as words, its field codes dropped
export function execWords(exec: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  let any = false;
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i]!;
    if (q) {
      if (c === "\\" && i + 1 < exec.length) cur += exec[++i];
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') {
      q = true;
      any = true;
    } else if (c === " " || c === "\t") {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += c;
  }
  if (cur || any) out.push(cur);
  return out.filter((w) => !/^%[fFuUdDnNickvm]$/.test(w)).map((w) => w.replace(/%%/g, "%"));
}

// the target of a launcher on the host; exec: a Linux desktop entry's Exec, read by the caller
export async function resolve(
  host: Host & { output(cmd: string): Promise<string> },
  path: string,
  exec?: string,
): Promise<Target> {
  const name = (path.split(/[\\/]/).pop() ?? path).replace(/\.(lnk|exe|desktop)$/i, "");
  if (host.os === "windows") {
    const ps = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(winScript(path), "utf16le").toString("base64")}`;
    const j = JSON.parse((await host.output(ps)).trim() || "{}");
    const raw = String(j.args ?? "").trim();
    return { exe: String(j.exe ?? ""), args: raw ? winWords(raw) : [], electron: !!j.electron, name };
  }
  const words = execWords(exec ?? path);
  const [cmd, ...args] = words;
  if (!cmd) return { exe: "", args: [], electron: false, name };
  // env NAME=value cmd ...: the command after them
  let i = 0;
  if (cmd === "env") while (i + 1 < words.length && /^-|=/.test(words[i + 1]!)) i++;
  const real = cmd === "env" ? words[i + 1]! : cmd;
  const rest = cmd === "env" ? words.slice(i + 2) : args;
  const exe = (await host.output(`sh -c ${shq(linuxScript(real))}`)).trim();
  const ok = await host.output(`sh -c ${shq(`d=$(dirname ${shq(exe)}); [ -f "$d/resources/app.asar" ] || [ -f "$d/resources/app/package.json" ] && echo yes`)}`);
  return { exe, args: rest, electron: ok.trim() === "yes", name };
}

// a Windows command line's arguments as words, as the C runtime splits them
export function winWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\") {
      let n = 0;
      while (s[i] === "\\") {
        n++;
        i++;
      }
      if (s[i] === '"') {
        cur += "\\".repeat(n >> 1);
        if (n & 1) cur += '"';
        else {
          q = !q;
          any = true;
        }
      } else {
        cur += "\\".repeat(n);
        i--;
      }
      continue;
    }
    if (c === '"') {
      q = !q;
      any = true;
    } else if (!q && (c === " " || c === "\t")) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}
