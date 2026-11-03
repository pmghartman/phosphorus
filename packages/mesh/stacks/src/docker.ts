// docker on this host: found and its compose v2 checked, installed from the
// distribution on Debian and Ubuntu when asked; every docker command run with its
// output appended to a log
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { errText, logf as log, markHot, now, run } from "@phosphorus/util";
import type { DockerInfo } from "@phosphorus/wire";

export const logf = (f: string, ...a: unknown[]) => log("[stacks] " + f, ...a);

// docker's name for this machine
export const arch = () => ({ x64: "amd64", arm64: "arm64", arm: "arm" })[process.arch as string] ?? process.arch;

// the docker binary off PATH as it is now, "" with none
export const dockerBin = () => Bun.which("docker", { PATH: process.env.PATH ?? "" }) ?? "";

// a Debian or Ubuntu host phosphorus runs as root on: one it can install Docker on
export function debianLike(osRelease = "/etc/os-release"): boolean {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || !Bun.which("apt-get")) return false;
  try {
    const t = readFileSync(osRelease, "utf8");
    return /^(ID|ID_LIKE)=.*\b(debian|ubuntu)\b/m.test(t);
  } catch {
    return false;
  }
}

let info: DockerInfo = { state: "unsupported", arch: arch() };
let checkedAt = 0;
const recheckMS = 60000;

export const dockerInfo = () => info;

// docker and its compose plugin looked for again: present, installable here, or not
export async function detect(): Promise<DockerInfo> {
  const bin = dockerBin();
  const next: DockerInfo = { state: "unsupported", arch: arch() };
  if (info.installing) next.installing = true;
  let why = "";
  if (!bin) why = "docker isn't installed";
  else {
    const v = await run([bin, "version", "--format", "{{.Server.Version}}"], { timeoutMs: 10000 });
    const c = await run([bin, "compose", "version", "--short"], { timeoutMs: 10000 });
    if (v.ok) next.version = v.stdout.trim();
    if (c.ok) next.compose = c.stdout.trim().replace(/^v/, "");
    if (!v.ok) why = "the docker daemon isn't answering: " + (v.output.trim().split("\n").at(-1) ?? "");
    else if (!c.ok) why = "docker compose v2 isn't installed";
    else if (!/^2\./.test(next.compose ?? "")) why = `docker compose ${next.compose} isn't v2`;
  }
  if (!why) next.state = "present";
  else {
    next.state = debianLike() ? "installable" : "unsupported";
    next.error = why;
  }
  // a failed install's reason kept over the plain absence it left
  if (next.state !== "present" && info.error?.startsWith("installing docker:")) next.error = info.error;
  checkedAt = now();
  if (JSON.stringify(next) !== JSON.stringify(info)) markHot();
  info = next;
  return info;
}

// docker as last seen, looked at again once a minute
export async function docker(): Promise<DockerInfo> {
  return now() - checkedAt > recheckMS ? detect() : info;
}

// the distribution's docker.io and a compose v2 plugin, whichever name it ships under
const installScript = `set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update
dpkg -s docker.io >/dev/null 2>&1 || dpkg -s docker-ce >/dev/null 2>&1 || apt-get install -y docker.io
if ! docker compose version >/dev/null 2>&1; then
  for p in docker-compose-plugin docker-compose-v2 docker-compose; do
    if apt-get install -y "$p"; then docker compose version >/dev/null 2>&1 && break; fi
  done
fi
systemctl enable --now docker
docker compose version
`;

// Docker installed here, its output into log; once at a time
export async function installDocker(logFile: string): Promise<void> {
  if (info.installing) return;
  if (!debianLike()) throw new Error("Docker is installed by phosphorus only on Debian and Ubuntu");
  info = { ...info, installing: true, error: undefined };
  markHot();
  logf("installing docker");
  try {
    const code = await exec(["sh", "-c", installScript], logFile, 20 * 60000);
    if (code !== 0) throw new Error(`the install exited ${code}`);
    info = { ...info, installing: undefined };
    await detect();
    if (info.state !== "present") throw new Error(info.error ?? "docker still isn't there");
    logf("docker installed: %s, compose %s", info.version, info.compose);
  } catch (e) {
    info = { ...info, installing: undefined, error: "installing docker: " + errText(e) };
    logf("%s", info.error);
    markHot();
    throw e;
  }
}

// argv run to its end, stdout and stderr appended to logFile as they come; its exit,
// -1 when it couldn't start or ran past timeoutMs
export async function exec(argv: string[], logFile: string, timeoutMs: number, cwd?: string): Promise<number> {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const p = Bun.spawn(argv, {
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      windowsHide: true,
      timeout: timeoutMs,
    });
    return await p.exited;
  } catch (e) {
    try {
      const f = openSync(logFile, "a");
      await Bun.write(Bun.file(logFile), readFileSync(logFile, "utf8") + errText(e) + "\n");
      closeSync(f);
    } catch {}
    return -1;
  } finally {
    closeSync(fd);
  }
}
