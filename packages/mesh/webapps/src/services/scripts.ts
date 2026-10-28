// the scripts, run by sh as the login in its own checkout
import { logf as log } from "@phosphorus/util";

export const logf = (f: string, ...a: unknown[]) => log("[services] " + f, ...a);

// one service the mesh can take: its repo cloned under ~/.phosphorus/services/<id>
// on the host, the scripts run in that checkout as the login, the port and mode
// published; the rest is what the apps page shows of it
export type Service = {
  id: string;
  name: string;
  tagline: string;
  about: string;
  features: string[];
  category: string;
  by: string;
  // the GitHub repository, cloned on the host; main is what's installed and updated to
  repo: string;
  // the icon's path in the repository, fetched off its main and served by the page
  icon: string;
  port: number;
  mode: "path" | "subdomain";
  // the host OSes its scripts run on, as the tailnet names them
  os: string[];
  // what the host needs before an install
  needs: string;
  // under the service's root, answering {version}
  versionPath: string;
  // the agents it asks the mesh's models as, listed in the agents app while published
  agents?: string[];
  // paths in the checkout a remove may keep aside, an install restoring them
  data: string[];
  // run by sh in the checkout: install (first time), update, remove (the unit undone)
  install: string;
  update: string;
  remove: string;
};

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
    mode: "path",
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
    mode: "path",
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

// script the sh script for op on s, run on the host in its unit
export function script(s: Service, op: Op, keep = false): string {
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

// launch the ssh script that starts op's script on the host: the script written
// under the login's .jobs, its last outcome cleared, then run as a transient user
// unit of the login's own manager (linger on, so it outlives this login), or as a
// plain background process where there's none; the unit's output to .log, its
// exit to .exit, the checkout's commit to .commit once done
export function launch(s: Service, op: Op, keep = false): string {
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
    `cat > "$j/${s.id}.sh" <<'${delim}'\n${script(s, op, keep)}${delim}\n` +
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
