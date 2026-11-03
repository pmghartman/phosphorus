// a game's start or stop line run on this host as its login, over ssh to this
// host's own sshd with the app's key: a login session of the account's, apart from
// phosphorus's service so a restart never takes the game down with it. Output to
// a log in the account's own folder, not the channel a backgrounded server would
// hold open; its last lines told back when the line fails
import { env, envInt, errText } from "@phosphorus/util";
import { Client } from "ssh2";
import type { Key } from "./keys.ts";

const tailMax = 4 * 1024;
const runMS = 60_000;

const shq = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const psq = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

// the command sent and what's written to its stdin, for a POSIX host: a sh read
// whole before it runs, so whatever shell the account has only starts it
export function unixRun(name: string, action: string, line: string): [string, string] {
  const script = [
    "{",
    'd="${XDG_STATE_HOME:-$HOME/.local/state}/phosphorus-games"',
    'mkdir -p "$d"',
    `log="$d/${name}.log"`,
    `printf '%s %s\\n' "--- $(date '+%Y-%m-%d %H:%M:%S')" ${shq(`${action}: ${line}`)} >>"$log"`,
    `"\${SHELL:-/bin/sh}" -lc ${shq(line)} </dev/null >>"$log" 2>&1`,
    "rc=$?",
    '[ "$rc" = 0 ] || tail -n 5 "$log"',
    'exit "$rc"',
    "}",
    "",
  ].join("\n");
  return ["sh -s", script];
}

// the same for Windows: powershell given the script encoded, which has cmd run the
// line with the log as its output, waiting on it alone and not what it leaves running
export function windowsRun(name: string, action: string, line: string): [string, string] {
  const inner = encoded(line);
  const script = [
    "$d = Join-Path $(if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:TEMP }) 'phosphorus-games'",
    "New-Item -ItemType Directory -Force -Path $d | Out-Null",
    `$env:PHOS_GAME_LOG = Join-Path $d ${psq(name + ".log")}`,
    `Add-Content -LiteralPath $env:PHOS_GAME_LOG -Value ('--- ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + ${psq(`${action}: ${line}`)})`,
    `$p = Start-Process -FilePath cmd.exe -ArgumentList '/d /c "powershell -NoProfile -NonInteractive -EncodedCommand ${inner} >>"%PHOS_GAME_LOG%" 2>&1 <NUL"' -NoNewWindow -PassThru`,
    "$null = $p.Handle",
    "$p.WaitForExit()",
    "if ($p.ExitCode -ne 0) { Get-Content -LiteralPath $env:PHOS_GAME_LOG -Tail 5 }",
    "exit $p.ExitCode",
  ].join("\n");
  return [`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded(script)}`, ""];
}

// line run as login; throws with the log's last lines, or ssh's reason
export function runAs(login: string, key: Key, name: string, action: string, line: string): Promise<void> {
  const [cmd, input] = process.platform === "win32" ? windowsRun(name, action, line) : unixRun(name, action, line);
  return new Promise((resolve, reject) => {
    const c = new Client();
    let tail = "";
    let settled = false;
    const done = (e?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      c.end();
      e ? reject(e) : resolve();
    };
    const timer = setTimeout(() => done(new Error(`${action} didn't finish in ${runMS / 1000}s`)), runMS);
    c.on("error", (e) => {
      const msg = errText(e);
      done(
        new Error(
          /authentication methods failed/i.test(msg)
            ? `${login} doesn't take the play/stop key here, set it up again`
            : `ssh to this host: ${msg}`,
        ),
      );
    });
    c.on("ready", () =>
      c.exec(cmd, (err, ch) => {
        if (err) return done(err);
        const keep = (b: Buffer) => void (tail = (tail + b.toString("utf8")).slice(-tailMax));
        ch.on("data", keep);
        ch.stderr.on("data", keep);
        let code: number | null | undefined;
        const end = () =>
          done(
            code === 0
              ? undefined
              : new Error(
                  (
                    tail.trim() || (code === undefined ? `${action} ended without a status` : `exit status ${code}`)
                  ).slice(-300),
                ),
          );
        // the exit status, not only the channel's close: something the line left
        // running may hold the channel open, on Windows above all
        ch.on("exit", (c: number | null) => {
          code = c;
          setTimeout(end, 200);
        });
        ch.on("close", end);
        ch.end(input);
      }),
    );
    c.connect({
      host: env("HOST_SSH_HOST", "127.0.0.1"),
      port: envInt("HOST_SSH_PORT", 22) || 22,
      username: login,
      privateKey: key.priv,
      readyTimeout: 10_000,
    });
  });
}

// whether login's password is good on host, at addr: what allowing play/stop as
// it asks, the same as a terminal there would
export function checkLogin(addr: { host: string; port: number }, login: string, pass: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => {
      c.end();
      resolve();
    });
    c.on("error", (e) => {
      c.end();
      const msg = errText(e);
      reject(new Error(/authentication methods failed/i.test(msg) ? `the saved login for ${login} was refused` : msg));
    });
    c.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pass)));
    c.connect({ ...addr, username: login, password: pass, tryKeyboard: true, readyTimeout: 10_000 });
  });
}
