// the games app's own parts: a game checked, the key's line kept alone, a start
// line run as this machine's shell would
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "@phosphorus/util";
import { check } from "../server/config.ts";
import { keptAround, keyLine } from "../server/keys.ts";
import { unixRun, windowsRun } from "../server/run.ts";

test("a game checked", () => {
  expect(check({ host: "Razer", name: "mc", port: "25565", start: " a ", stop: "b" })).toEqual({
    host: "razer",
    name: "mc",
    port: 25565,
    start: "a",
    stop: "b",
  });
  expect(check({ host: "razer", name: "mc", port: 7777, start: "", stop: "" })).toMatchObject({ start: "" });
  expect(check({ host: "razer", name: "Mc", port: 1 })).toBe("a name is lowercase letters, digits and -");
  expect(check({ host: "razer", name: "mc", port: 70000 })).toBe("port is 1-65535");
  expect(check({ host: "razer", name: "mc", port: 1, start: "a" })).toBe("start and stop go together");
  expect(check({ host: "", name: "mc", port: 1 })).toBe("pick a host");
});

test("the key's line: added once, game-control's swapped out", () => {
  const line = keyLine("ssh-ed25519 AAAAC3 phosphorus-games\n");
  expect(line).toBe('restrict,from="127.0.0.1,::1" ssh-ed25519 AAAAC3 phosphorus-games');
  const old = 'restrict,command="/x/phosphorus game-control --home /x" ssh-ed25519 OLD phosphorus-game-control';
  expect(keptAround(`ssh-rsa mine\n${old}\n`, line)).toEqual(["ssh-rsa mine"]);
  expect(keptAround(`ssh-rsa mine\n${line}\n`, line)).toBeUndefined();
});

// the line's output in the log, its failure's last lines told back
async function runs(argv: string[], input: string, env: Record<string, string>) {
  const p = Bun.spawn(argv, { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe", env });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out };
}

const sh = process.platform === "win32" ? "" : which("sh");
test.skipIf(!sh)("a start line run by sh, its output logged", async () => {
  const home = mkdtempSync(join(tmpdir(), "games-"));
  const env = { HOME: home, SHELL: "/bin/sh", PATH: process.env.PATH ?? "" };
  const [cmd, script] = unixRun("mc", "start", "echo it's up");
  const ok = await runs(cmd.split(" "), script, env);
  expect(ok.code).toBe(0);
  const log = readFileSync(join(home, ".local/state/phosphorus-games/mc.log"), "utf8");
  expect(log).toContain("start: echo it's up\nit's up\n");
  const [c2, s2] = unixRun("mc", "stop", "echo nope; exit 3");
  const bad = await runs(c2.split(" "), s2, env);
  expect(bad.code).toBe(3);
  expect(bad.out).toContain("nope");
});

test.skipIf(process.platform !== "win32")(
  "a start line run by powershell, its output logged",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "games-"));
    const env = { ...process.env, LOCALAPPDATA: dir } as Record<string, string>;
    const [cmd] = windowsRun("mc", "start", 'Write-Output "it\'s up"');
    const ok = await runs(cmd.split(" "), "", env);
    expect(ok.code).toBe(0);
    expect(readFileSync(join(dir, "phosphorus-games", "mc.log"), "utf8")).toContain("it's up");
    const [c2] = windowsRun("mc", "stop", "Write-Output nope; exit 3");
    const bad = await runs(c2.split(" "), "", env);
    expect(bad.code).toBe(3);
    expect(bad.out).toContain("nope");
  },
  30000,
);
