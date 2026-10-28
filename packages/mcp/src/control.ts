// the mesh's control past the files and chat: power, chat edits, terminals,
// the audit, and a file's stat for files_list
import { obj } from "@phosphorus/util";
import { adminOf, arr, errc, knownHost, type Meta, name, noCreds, numOr, object, pressed, src, str, type Tool, ToolError, waitMaxS } from "./common.ts";
import { auditRows } from "./extra.ts";
import { gitCreds } from "./forgejo.ts";
import { typeTerminal } from "./hosts.ts";

export const controlTools = (): Tool[] => [
  {
    name: "host_power", title: "Restart a host", scope: "key", admin: true, destructive: true,
    description:
      "Restart phosphorus on a host, or reboot the machine. Its terminals and services drop until it's back. " +
      "confirm must repeat the host's name. Admins only.",
    schema: object({
      host: name, action: { type: "string", enum: ["restart", "reboot"] },
      confirm: { type: "string", description: "the host's name again" },
    }, "host", "action", "confirm"),
    run: (a, m) => {
      adminOf(m);
      const h = knownHost(a);
      if (str(a.confirm) !== h) throw errc("bad_input", `confirm must be ${h}`);
      return pressed(src.actions.op(h, "power", { action: str(a.action) }));
    },
  },
  {
    name: "chat_edit", title: "Edit or withdraw a chat line", scope: "key",
    description: "Edit or delete one of your own chat lines by its ref from chat_history; deleting an invite from show_file withdraws it.",
    schema: object({
      ref: { type: "string", description: "host:seq, from chat_history" },
      action: { type: "string", enum: ["edit", "delete"] },
      text: { type: "string", description: "edit only: the new text" },
    }, "ref", "action"),
    run: (a, m) => {
      if (!m.caller) throw errc("forbidden", "on a user's key only");
      return pressed(src.actions.chatEdit(m.caller.user, str(a.ref), str(a.action), str(a.text)));
    },
  },
  {
    name: "terminal_run", title: "Run a command on a host", destructive: true,
    description:
      "Run a command or a whole script on a host as you, with exactly the rights of your saved login, as if you were " +
      "at its shell. With a login saved it signs in over ssh on its own, no window needed, and returns the exit code and the " +
      "combined output. With one saved it defaults to a persistent session: one login shell kept for you on the host, so cd, " +
      "environment variables and background jobs carry from one call to the next, the way your own shell session does; reset " +
      "starts it fresh. mode ssh runs each command in a fresh shell instead (no state kept); mode tab types one line into your " +
      "shared, logged-in terminal tab (open_terminal opens one) and returns its screen. stdin feeds the command's input, e.g. " +
      "cat > file to write any file the login may. git true hands git your forgejo login for clone, fetch and push over https. " +
      "Never types a password. " + noCreds,
    schema: object({
      host: name,
      command: { type: "string", description: "run as typed by the login's shell; several lines over ssh, one in a tab" },
      stdin: { type: "string", description: "text fed to the command's stdin (not in a tab)" },
      git: { type: "boolean", description: "your forgejo login handed to git for the mesh's forgejo; runs in a fresh shell", default: false },
      mode: { type: "string", enum: ["auto", "session", "ssh", "tab"], description: "auto: a persistent session with a saved login, else a shared tab; session: persistent; ssh: fresh shell each call; tab: the shared terminal", default: "auto" },
      reset: { type: "boolean", description: "session: drop the kept shell and start a fresh one for this call", default: false },
      id: { type: "string", description: "tab only: terminal id from terminal_screen, if several are shared" },
      wait_s: { type: "integer", description: "ssh/session: seconds before the command is killed, up to 600; tab: seconds to wait for output to settle, up to 120", default: 60 },
    }, "host", "command"),
    run: async (a, m) => {
      const h = knownHost(a);
      let cmd = str(a.command);
      if (!cmd.trim()) throw errc("bad_input", "missing 'command'");
      if (!m.caller) throw errc("forbidden", "on a user's key only");
      const mode = str(a.mode) || "auto";
      const login = m.caller.login?.(h);
      // git is a fresh shell whatever the mode: its credential helper is
      // scoped to that one process
      const oneShot = mode === "ssh" || a.git === true;
      const persistent = mode === "session" || (mode === "auto" && !!login && !oneShot);
      if (oneShot || persistent) {
        if (!login) throw errc("forbidden", `your key carries no saved login for ${h}: save one in the browser, the key picks it up`);
        const w = Math.trunc(numOr(a.wait_s, 60));
        if (w < 1 || w > 600) throw errc("bad_input", "wait_s is 1 to 600");
        let stdin = str(a.stdin);
        if (a.git === true) {
          const [pre, creds] = gitCreds(m.caller);
          cmd = pre + cmd;
          stdin = creds + stdin;
        }
        const p = { user: login.user, pass: login.pass, cmd, stdin, timeout: w };
        if (persistent) return pressed(src.actions.op(h, "shell", { ...p, reset: a.reset === true }));
        return pressed(src.actions.op(h, "exec", p));
      }
      if (/[\r\n]/.test(cmd)) throw errc("bad_input", `one line only in a tab; save a login for ${h} to run scripts over ssh`);
      if (str(a.stdin)) throw errc("bad_input", `stdin needs a saved login for ${h}`);
      const w = Math.trunc(numOr(a.wait_s, 30));
      if (w < 1 || w > waitMaxS) throw errc("bad_input", `wait_s is 1 to ${waitMaxS}`);
      try {
        return await typeTerminal(h, cmd, str(a.id), w, m.caller.user, true);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        throw errc("not_found", `${why}; open_terminal opens one logged in with your saved login, or save a login so it runs over ssh`);
      }
    },
  },
  {
    name: "audit_log", title: "Audit log", read: true, scope: "key",
    description:
      "Every write made through a key on this host, newest last: when, who, through which agent, the tool, its " +
      "arguments and whether it went through. Your own; an admin may ask for everyone's.",
    schema: object({ all: { type: "boolean", default: false }, limit: { type: "integer", description: "up to 500", default: 100 } }),
    run: (a, m) => {
      if (!m.caller) throw errc("forbidden", "on a user's key only");
      const all = a.all === true;
      if (all && !m.caller.admin) throw errc("forbidden", "everyone's is for admins");
      const n = Math.trunc(numOr(a.limit, 100));
      if (n < 1 || n > 500) throw errc("bad_input", "limit is 1 to 500");
      const rows = auditRows(m.caller.user, all, n);
      rows.sort((x, y) => (str(x.at) < str(y.at) ? -1 : str(x.at) > str(y.at) ? 1 : 0));
      return { host: src.self().host, rows };
    },
  },
];

// fileStat one file or folder in a share: exists, folder, size and mtime
export async function fileStat(a: Record<string, any>, m: Meta): Promise<Record<string, any>> {
  const h = knownHost(a);
  const p = str(a.path).replace(/^\/+|\/+$/g, "");
  if (!p) return { path: "", exists: true, folder: true };
  const i = p.lastIndexOf("/");
  const dir = p.slice(0, i + 1), base = p.slice(i + 1);
  let v: unknown;
  try {
    v = await pressed(src.actions.files(m.caller, h, "list", str(a.share), { path: dir }));
  } catch (e) {
    if (e instanceof ToolError && e.code === "not_found") return { path: p, exists: false };
    throw e;
  }
  for (const e of arr(obj(v)?.entries)) {
    const x = obj(e) ?? {};
    if (str(x.name) !== base) continue;
    const out: Record<string, any> = { path: p, exists: true, folder: x.dir === true, mtime: x.mtime ?? null };
    if (x.dir !== true) out.size = x.size ?? null;
    return out;
  }
  return { path: p, exists: false };
}
