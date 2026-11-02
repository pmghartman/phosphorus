// the scripts, run by sh as the login in its own checkout
import { logf as log } from "@phosphorus/util";
import { envSetup, helpers, loadEnv } from "./native.ts";

export const logf = (f: string, ...a: unknown[]) => log("[services] " + f, ...a);

// one service the mesh can take: its repo cloned under ~/.phosphorus/services/<id>
// on the host, the scripts run in that checkout as the login, or a catalogue
// recipe installing it on the host itself; the port published, its mode picked by the host (a subdomain
// once *.<domain> reaches the mesh); the rest is what the apps page shows of it
export type Service = {
  id: string;
  name: string;
  tagline: string;
  about: string;
  features: string[];
  category: string;
  by: string;
  // the GitHub repository, cloned on the host; main is what's installed and updated to;
  // a catalogue service's project page
  repo: string;
  // the icon's path in the repository, fetched off its main and served by the page, or a URL
  icon: string;
  port: number;
  // the host OSes its scripts run on, as the tailnet names them
  os: string[];
  // which of them, said for people: versions, machines
  compat?: string;
  // what the host needs before an install
  needs: string;
  // under the service's root, answering {version}
  versionPath?: string;
  // the agents it asks the mesh's models as, listed in the agents app while published
  agents?: string[];
  // paths in the checkout a remove may keep aside, an install restoring them
  data: string[];
  // run by sh in the checkout: install (first time), update, remove (the unit undone);
  // blank for a catalogue service, its steps its recipe's
  install: string;
  update: string;
  remove: string;
  native?: Native;
};

// a catalogue recipe (native.ts): install, run again to update, and remove; the
// .env names given random hex on its first install; whether it needs root
export type Native = { install: string; remove: string; secrets: string[]; sudo: boolean };

// where a step runs: the host's tailnet address its ports bind to, the mesh's domain,
// the URL the service is opened at
export type Where = { ip: string; domain: string; url: string };

export const Services: Service[] = [
  {
    id: "circuit",
    name: "Circuit",
    tagline: "a schematic editor with a live circuit solver",
    about:
      "Draw a circuit and watch it solve as you edit: DC, transient and graph layout from a Rust core, the UI served by its own small web server. Built from source on the host, updated from its own header button or here.",
    features: [
      "live solving as you draw",
      "transient analysis",
      "a desktop app too, from the same checkout",
      "updates itself from main",
    ],
    category: "engineering",
    by: "pmghartman",
    repo: "https://github.com/pmghartman/circuit",
    icon: "src-tauri/icons/icon.png",
    port: 8099,
    os: ["linux"],
    needs: "git; Rust is installed by the build when missing (several minutes the first time)",
    versionPath: "api/version",
    data: [],
    install: "PORT=8099 scripts/install.sh",
    update: "scripts/update.sh",
    remove: "scripts/uninstall.sh",
  },
  {
    id: "tavern",
    name: "Tavern",
    tagline: "D&D 5e in a chat room, an AI dungeon master on the mesh",
    about:
      "A strict rules engine decides every outcome while a dungeon master on the mesh's models tells the story: campaigns, character sheets, grid combat, adventure modules read from a PDF. The DM asks phosphorus's model gateway as the Tavern agent.",
    features: [
      "campaign lobby and persistent memory",
      "full character creation and level-up",
      "grid combat with the real action economy",
      "adventure modules read from PDF or text",
      "the DM on the mesh's models, assigned on the agents page",
    ],
    category: "games",
    by: "pmghartman",
    repo: "https://github.com/pmghartman/tavern",
    icon: "src-tauri/icons/icon.png",
    port: 8484,
    os: ["linux"],
    needs: "git and Node 20+ (a build toolchain when no prebuilt sqlite binary fits)",
    versionPath: "api/health",
    agents: ["agent-tavern"],
    data: ["data", ".env"],
    install: "scripts/rebuild.sh",
    update: "scripts/update.sh",
    remove:
      'systemctl --user disable --now tavern; rm -f "$HOME/.config/systemd/user/tavern.service"; systemctl --user daemon-reload',
  },
];

export const serviceOf = (id: string) => Services.find((s) => s.id === id);

// the repository's owner and name, for GitHub's API and raw files
export function repoOf(s: { repo: string }): { owner: string; name: string } | undefined {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s.repo);
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

export type Op = "install" | "update" | "remove";
export const Ops: Op[] = ["install", "update", "remove"];

// how long each step may run on the host: a first build of circuit takes a while
export const opTimeoutMS: Record<Op, number> = { install: 45 * 60000, update: 30 * 60000, remove: 5 * 60000 };
// the ssh start of a step, the script written and its unit begun
export const launchTimeoutMS = 60000;

export const logTail = 4 << 10;

export const svcRoot = '"$HOME/.phosphorus/services"';
export const checkoutDir = (id: string) => `"$HOME/.phosphorus/services/${id}"`;
export const keepDir = (id: string) => `"$HOME/.phosphorus/services/${id}.data"`;
// the unit a step runs as, the files it leaves: <id>.sh, .log, .exit, .commit
export const unitOf = (id: string) => `phos-svc-${id}`;

// the login's own PATH and systemd user manager, reached without a seat
export const head = (s: Service) =>
  "set -e\n" +
  'PATH="$HOME/.local/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; export PATH\n' +
  'if [ -z "$XDG_RUNTIME_DIR" ]; then XDG_RUNTIME_DIR="/run/user/$(id -u)"; export XDG_RUNTIME_DIR; fi\n' +
  'if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; export DBUS_SESSION_BUS_ADDRESS; fi\n' +
  `dir=${checkoutDir(s.id)}\nkeep=${keepDir(s.id)}\n`;

// the kept data back into a fresh checkout, the keep folder gone once empty
export const restore = (s: Service) =>
  s.data.length
    ? 'if [ -d "$keep" ]; then\n' +
      `  for p in ${s.data.join(" ")}; do\n` +
      '    if [ -e "$keep/$p" ]; then rm -rf "$dir/$p"; mv "$keep/$p" "$dir/$p"; echo "restored $p from $keep"; fi\n' +
      "  done\n" +
      '  rmdir "$keep" 2>/dev/null || true\n' +
      "fi\n"
    : "";

// the checkout's data moved aside before the checkout goes
export const aside = (s: Service) =>
  s.data.length
    ? '  mkdir -p "$keep"\n' +
      `  for p in ${s.data.join(" ")}; do\n` +
      '    if [ -e "$dir/$p" ]; then rm -rf "$keep/$p"; mv "$dir/$p" "$keep/$p"; echo "kept $p in $keep"; fi\n' +
      "  done\n"
    : "";

// where the launch leaves a step's sudo password and the askpass reading it: the
// login's runtime folder (tmpfs), else beside the step's script, the login's alone
const pwPaths = (s: Service) =>
  `pwf="$XDG_RUNTIME_DIR/${unitOf(s.id)}.pw"; ask="$XDG_RUNTIME_DIR/${unitOf(s.id)}.askpass"\n` +
  `if [ ! -d "$XDG_RUNTIME_DIR" ] || [ ! -w "$XDG_RUNTIME_DIR" ]; then pwf=${svcRoot}/.jobs/${s.id}.pw; ask=${svcRoot}/.jobs/${s.id}.askpass; fi\n`;

// a recipe's step under its helpers, in its folder with its .env loaded; the sudo
// password the launch left used through an askpass and gone when the step ends
function nativeStep(s: Service, n: Native, op: Op, keep: boolean, w: Where): string {
  const vars =
    `ID=${s.id}\nNAME='${s.name.replace(/'/g, "")}'\nOP=${op}\nKEEP=${keep ? 1 : 0}\n` +
    pwPaths(s) +
    'if [ -r "$pwf" ] && [ -x "$ask" ]; then SUDO_ASKPASS="$ask"; export SUDO_ASKPASS; fi\n' +
    "trap 'rm -f \"$pwf\" \"$ask\"' EXIT\ntrap 'exit 143' INT TERM\n";
  if (op === "remove")
    return (
      head(s) +
      'if [ -d "$dir" ]; then\n' +
      'cd "$dir"\n' +
      vars +
      helpers +
      `if [ -f .env ]; then ${loadEnv.trim()}; fi\n` +
      `(\n${n.remove}\n) || echo "note: the uninstall step failed; removing $dir anyway"\n` +
      "cd /\n" +
      (keep ? aside(s) : "") +
      'rm -rf "$dir"\n' +
      'echo "removed $dir"\n' +
      "else\n" +
      '  echo "nothing installed in $dir"\n' +
      "fi\n"
    );
  return (
    head(s) +
    (op === "update"
      ? '[ -f "$dir/.env" ] || { echo "nothing installed in $dir; install first" >&2; exit 2; }\n'
      : 'mkdir -p "$dir"\n' + restore(s)) +
    'cd "$dir"\n' +
    vars +
    envSetup({ port: s.port, secrets: n.secrets }, w) +
    loadEnv +
    helpers +
    n.install +
    `\necho "${s.name} ${op === "update" ? "updated" : "installed"}, on port ${s.port}"\n`
  );
}

// script the sh script for op on s, run on the host in its unit
export function script(s: Service, op: Op, keep = false, w: Where = { ip: "", domain: "", url: "" }): string {
  const n = s.native;
  if (n) {
    if (op !== "remove" && !w.ip) return 'echo "no tailnet address for this host" >&2; exit 2\n';
    return nativeStep(s, n, op, keep, w);
  }
  switch (op) {
    case "install":
      return (
        head(s) +
        'mkdir -p "$(dirname "$dir")"\n' +
        'if [ -d "$dir/.git" ]; then\n' +
        '  echo "updating the checkout in $dir"\n' +
        '  git -C "$dir" fetch -q origin main\n' +
        '  git -C "$dir" reset -q --hard origin/main\n' +
        "else\n" +
        `  echo "cloning ${s.repo} into $dir"\n` +
        `  git clone -q ${s.repo}.git "$dir"\n` +
        "fi\n" +
        restore(s) +
        'cd "$dir"\n' +
        s.install +
        "\n"
      );
    case "update":
      return (
        head(s) +
        '[ -d "$dir/.git" ] || { echo "no checkout in $dir; install first" >&2; exit 2; }\n' +
        'cd "$dir"\n' +
        s.update +
        "\n"
      );
    case "remove":
      return (
        head(s) +
        'if [ -d "$dir" ]; then\n' +
        '  cd "$dir"\n' +
        `  ( ${s.remove} ) || echo "note: the uninstall step failed; removing the checkout anyway"\n` +
        "  cd /\n" +
        (keep ? aside(s) : "") +
        '  rm -rf "$dir"\n' +
        '  echo "removed $dir"\n' +
        "else\n" +
        '  echo "no checkout in $dir"\n' +
        "fi\n"
      );
  }
}

// a recipe that needs root: passwordless sudo as it is, else the password given
// checked now, so a wrong one fails the start, and left for the step's askpass
function sudoCheck(s: Service, pass: string): string {
  return (
    pwPaths(s) +
    'rm -f "$pwf" "$ask"\n' +
    "if ! sudo -n true 2>/dev/null; then\n" +
    (pass
      ? `  ( umask 077; printf '%s' '${Buffer.from(pass).toString("base64")}' | base64 -d > "$pwf"; printf '#!/bin/sh\\ncat "%s"\\n' "$pwf" > "$ask"; chmod 700 "$ask" )\n` +
        '  if ! out=$(sudo -S -k -v -p "" < "$pwf" 2>&1); then rm -f "$pwf" "$ask"; echo "sudo refused $(id -un) on $(hostname): $out" >&2; exit 5; fi\n'
      : '  echo "$(id -un) has no passwordless sudo on $(hostname): give its sudo password" >&2; exit 5\n') +
    "fi\n"
  );
}

// launch the ssh script that starts op's script on the host: the script written
// under the login's .jobs, its last outcome cleared, then run as a transient user
// unit of the login's own manager (linger on, so it outlives this login), or as a
// plain background process where there's none; the unit's output to .log, its
// exit to .exit, the checkout's commit to .commit once done
export function launch(s: Service, op: Op, keep = false, w?: Where, sudoPass = ""): string {
  const unit = unitOf(s.id);
  // the step's script as a quoted heredoc: no line of a catalogue script is this
  const delim = "PHOS_JOB_END";
  const secs = Math.round(opTimeoutMS[op] / 1000);
  return (
    "set -e\n" +
    'if [ -z "$XDG_RUNTIME_DIR" ]; then XDG_RUNTIME_DIR="/run/user/$(id -u)"; export XDG_RUNTIME_DIR; fi\n' +
    'if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; export DBUS_SESSION_BUS_ADDRESS; fi\n' +
    `j=${svcRoot}/.jobs\n` +
    `dir=${checkoutDir(s.id)}\n` +
    'mkdir -p "$j"\n' +
    `cat > "$j/${s.id}.sh" <<'${delim}'\n${script(s, op, keep, w)}${delim}\n` +
    (s.native?.sudo ? sudoCheck(s, sudoPass) : "") +
    `rm -f "$j/${s.id}.exit" "$j/${s.id}.commit"\n` +
    `: > "$j/${s.id}.log"\n` +
    // the step outlives this login: linger, by the login itself or sudo without a prompt
    "linger=0\n" +
    'if loginctl enable-linger "$(id -un)" 2>/dev/null || sudo -n loginctl enable-linger "$(id -un)" 2>/dev/null; then linger=1; fi\n' +
    `run='sh "$1" >"$2" 2>&1; echo $? >"$3"; if [ -d "$4/.git" ]; then git -C "$4" rev-parse HEAD >"$5" 2>/dev/null; fi; true'\n` +
    'if [ "$linger" = 1 ] && command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then\n' +
    `  systemctl --user stop ${unit}.service 2>/dev/null || true\n` +
    `  systemctl --user reset-failed ${unit}.service 2>/dev/null || true\n` +
    `  systemd-run --user --quiet --collect --unit=${unit} -p RuntimeMaxSec=${secs} sh -c "$run" ${unit} "$j/${s.id}.sh" "$j/${s.id}.log" "$j/${s.id}.exit" "$dir" "$j/${s.id}.commit"\n` +
    `  echo "started as the user unit ${unit}"\n` +
    "else\n" +
    `  nohup setsid sh -c "$run" ${unit} "$j/${s.id}.sh" "$j/${s.id}.log" "$j/${s.id}.exit" "$dir" "$j/${s.id}.commit" >/dev/null 2>&1 &\n` +
    '  if [ "$linger" = 1 ]; then echo "started in the background"; else echo "started in the background; no linger: it stops if $(id -un) logs out"; fi\n' +
    "fi\n"
  );
}
