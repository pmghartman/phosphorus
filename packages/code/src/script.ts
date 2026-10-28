// what runs on the host: a setup script fed to sh -s (the skill, mcp.json),
// then claude itself under sh -c, its secrets read off stdin before claude
// takes it over, never in argv or on disk
import { randomBytes } from "node:crypto";
import { marshal } from "@phosphorus/util";
import { unzip } from "./zip.ts";

// configDir claude's own config on the host, apart from the user's
export const configDir = `"$HOME/.phosphorus/claude"`;
// pathPrefix where claude's installers put it, ahead of a non-login PATH
export const pathPrefix = `PATH="$HOME/.local/bin:$HOME/.claude/local:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; `;
// keyVar the env var mcp.json's header reads the key from
export const keyVar = "PHOSPHORUS_MCP_KEY";
// ocDir opencode's config on the host, apart from the user's own
export const ocDir = `"$HOME/.phosphorus/opencode"`;
// ocPath where opencode's installer puts it, ahead of a non-login PATH
export const ocPath = `PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; `;

const skillPathRe = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const envNameRe = /^[A-Z_][A-Z0-9_]*$/;

// Mesh the model the mesh serves a session: whichever the Agents page assigns
// its harness; the rest are Anthropic's
export const Mesh = ["mesh"];

// the gateway names the harnesses ask by, the Agents page's assignments
export const claudeAgent = "agent-claude-code";
export const ocAgent = "agent-opencode";

// Anthropic the models on the user's own subscription, claude's aliases
export const Anthropic = ["opus", "sonnet", "haiku"];

// Perms the permission modes the page offers
export const Perms = ["default", "acceptEdits", "plan", "bypassPermissions"];

// provider "mesh" or "anthropic", "" for no such model
export function provider(m: string): string {
  if (Mesh.includes(m) || m.startsWith("agent-")) return "mesh";
  if (Anthropic.includes(m)) return "anthropic";
  return "";
}

// quote a word for sh, single quoted, as the launch scripts quote theirs
export const quote = (s: string) => "'" + s.replaceAll("'", `'\\''`) + "'";

// shDir a folder as sh reads it, ~ its home
export function shDir(d: string): string {
  d = d.trim();
  if (d === "" || d === "~") return `"$HOME"`;
  if (d.startsWith("~/")) return `"$HOME"/` + quote(d.slice(2));
  return quote(d);
}

// Creds what one start needs of its user, gathered while they're logged in
export type Creds = {
  // user, pass the host login
  user: string;
  pass: string;
  // key the user's mcp key: the mesh models' token, mcp.json's bearer
  key: string;
  // token the Anthropic subscription token, anthropic models only
  token: string;
  // base the mesh's frontend as the host reaches it, http://ip:port
  base: string;
  // skill the phosphorus skill's zip
  skill?: Uint8Array;
};

export const creds = (c: Partial<Creds>): Creds => ({ user: "", pass: "", key: "", token: "", base: "", ...c });

// envLines the env claude starts with, a line each: NAME=value
export function envLines(model: string, c: Creds): string[] {
  const env: [string, string][] = [[keyVar, c.key]];
  switch (provider(model)) {
    case "mesh": {
      const main = claudeAgent, fast = claudeAgent + "-fast", big = claudeAgent;
      env.push(
        ["ANTHROPIC_BASE_URL", c.base + "/api/model"], ["ANTHROPIC_AUTH_TOKEN", c.key],
        ["ANTHROPIC_MODEL", main], ["ANTHROPIC_SMALL_FAST_MODEL", fast],
        ["ANTHROPIC_DEFAULT_HAIKU_MODEL", fast], ["ANTHROPIC_DEFAULT_SONNET_MODEL", big],
        ["ANTHROPIC_DEFAULT_OPUS_MODEL", big], ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
        ["API_TIMEOUT_MS", "3600000"],
      );
      break;
    }
    case "anthropic":
      if (!c.token) throw new Error("no Anthropic token saved: paste one from claude setup-token in settings");
      env.push(["CLAUDE_CODE_OAUTH_TOKEN", c.token]);
      break;
    default:
      throw new Error(`no model ${model}`);
  }
  return env.map(([k, v]) => {
    if (!envNameRe.test(k) || !v || /[\r\n\0]/.test(v)) throw new Error(`${k} is missing or holds a line break`);
    return `${k}=${v}`;
  });
}

// envBlock the env lines as fed to the launch script, a blank line ending them
export const envBlock = (lines: string[]) => lines.join("\n") + "\n\n";

// launchCommand claude in dir, its env read off stdin first; sh -c so any
// login shell runs it the same
export function launchCommand(dir: string, model: string, perm: string, resume: string): string {
  const args = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--model", model, "--permission-prompt-tool", "stdio",
    "--mcp-config", `"$CLAUDE_CONFIG_DIR/mcp.json"`, "--strict-mcp-config", "--allowedTools", "mcp__phosphorus"];
  if (perm && perm !== "default") args.push("--permission-mode", perm);
  if (resume) args.push("--resume", quote(resume));
  const script = pathPrefix +
    "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL CLAUDE_CODE_OAUTH_TOKEN; " +
    `while IFS= read -r l && [ -n "$l" ]; do export "$l"; done; ` +
    "CLAUDE_CONFIG_DIR=" + configDir + "; export CLAUDE_CONFIG_DIR; " +
    "cd " + shDir(dir) + " || exit 3; " +
    "command -v claude >/dev/null 2>&1 || exit 127; " +
    "exec " + args.join(" ");
  return "sh -c " + quote(script);
}

// mcpConfig phosphorus's server for claude, the key read from the env
export const mcpConfig = (base: string) =>
  marshal({ mcpServers: { phosphorus: { type: "http", url: base + "/api/mcp",
    headers: { Authorization: "Bearer ${" + keyVar + "}", "X-Phosphorus-Via": "claude-code" } } } });

// setupScript for sh -s: claude's config dir, mcp.json and the skill fresh,
// whatever was there of the skill before gone
export function setupScript(skill: Uint8Array | undefined, base: string): string {
  const files = new Map<string, string>();
  if (skill?.length) {
    for (const [name, body] of unzip(skill)) {
      if (!skillPathRe.test(name) || name.includes("..")) throw new Error(`bad skill file ${name}`);
      files.set("skills/" + name, new TextDecoder().decode(body));
    }
  }
  files.set("mcp.json", mcpConfig(base));
  let s = `set -e\numask 077\nD=${configDir}\nmkdir -p "$D"\nrm -rf "$D/skills/phosphorus"\n`;
  for (const n of [...files.keys()].sort()) {
    let body = files.get(n)!;
    if (body.includes("\0")) throw new Error(`${n} isn't text`);
    if (!body.endsWith("\n")) body += "\n";
    let eof = "PHOS_EOF_" + randHex(8);
    while (body.includes(eof)) eof = "PHOS_EOF_" + randHex(8);
    const i = n.lastIndexOf("/");
    if (i > 0) s += `mkdir -p "$D"/${quote(n.slice(0, i))}\n`;
    s += `cat > "$D"/${quote(n)} <<'${eof}'\n${body}${eof}\n`;
  }
  return s + pathPrefix + "\ncommand -v claude >/dev/null 2>&1 || exit 127\n";
}

export const randHex = (n: number) => randomBytes(n).toString("hex");
