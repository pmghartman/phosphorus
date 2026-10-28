// the tools every caller gets: the mesh read, its files, chat and buttons
import { jsNumber } from "@phosphorus/files";
import { obj } from "@phosphorus/util";
import { chatRows, chatWait, chatWaitMax } from "./chat.ts";
import { adminOf, arr, askerOf, byOf, codeOf, errc, gameNameRe, jsString, knownHost, meshHosts, nameRe, name, noCreds, numOr, object, pressed, src, str, type Tool, ToolError, waitMaxS } from "./common.ts";
import { fileStat } from "./control.ts";
import { channelKnown, noteOpened, openedFor, viaOf } from "./extra.ts";
import { hostStats, statsAll, watchScreens } from "./hosts.ts";

const chatMax = 50;
const filePage = 12000;

const notKnown = (to: string) => errc("not_found", `no one called ${to}; people lists who's on, any user's name works`);

export const coreTools = (): Tool[] => [
  {
    name: "mesh_hosts", read: true,
    description: "Every host on the phosphorus mesh: whether it runs phosphorus, its OS and version.",
    schema: object({ health: { type: "boolean", default: false, description: "key only: each phosphorus host's health too, answering, version, round trip and tunnel" } }),
    run: async (a, m) => {
      const self = src.self();
      // this host's own row carries no version; copies so the mesh's stays as is
      const hosts = src.tailnet().map((d) => (d.name === self.host && !d.version ? { ...d, version: self.version } : d));
      const out: Record<string, any> = { self, domain: src.domain(), hosts };
      if (a.health === true) {
        if (!m.caller) throw errc("forbidden", "health on a user's key only");
        out.health = await pressed(src.actions.op("", "mesh_health", undefined));
      }
      return out;
    },
  },
  {
    name: "services", read: true,
    description: "Every service published on the mesh, by host, with its name and where it is served.",
    schema: object({
      host: { type: "string", description: "with name: the service's host" },
      name: { type: "string", description: "key only: check this one service on host right now instead" },
    }),
    run: (a, m) => {
      if (str(a.name)) {
        if (!m.caller) throw errc("forbidden", "a service check on a user's key only");
        return pressed(src.actions.op(knownHost(a), "service_health", { name: str(a.name) }));
      }
      return src.routes().map((r) => {
        const row = { ...r };
        if (r.type !== "game") {
          const bp = str(r.base_path);
          const base = bp ? bp.replace(/^\/+|\/+$/g, "") + "/" : "";
          // no domain: this host's own name on the tailnet
          const domain = src.domain();
          const at = domain ? "https://" + domain : "http://" + (process.env.SELF_HOST ?? "");
          if (r.mode === "subdomain" && domain) row.url = `https://${str(r.name)}.${domain}/${base}`;
          else row.url = `${at}/${str(r.host)}/${str(r.name)}/${base}`;
        }
        return row;
      });
    },
  },
  {
    name: "host_stats", read: true,
    description: "Live cpu, memory, disk, gpu, network, phosphorus's parts and top processes of one host; no host, a row of percents for every host.",
    schema: object({ host: { type: "string", description: "host name, as mesh_hosts lists it; blank for every host's row at once" } }),
    run: (a) => (str(a.host) ? hostStats(knownHost(a)) : statsAll()),
  },
  {
    name: "git", read: true,
    description: "The git hosts (forgejo): which is master, which are replicas, how far behind, reachable or not.",
    schema: object(),
    run: () => src.gitHosts(),
  },
  {
    name: "models", read: true,
    description:
      "The models: each agent's (chat, inline, code, claude-code, opencode) assigned mesh host and the one answering, " +
      "each mesh model host, its file, state, memory and the agents on it, and the last call's context window in tokens (system prompt, chat, prompt, reply) and speed.",
    schema: object(),
    run: () => src.model(),
  },
  {
    name: "people", read: true,
    description: "Who is on phosphorus right now: each person connected, the host they are on, and whether they are typing.",
    schema: object(),
    run: () =>
      src.people().map((p) => {
        const row: Record<string, any> = { name: p.name ?? null, host: p.host ?? null };
        const t = str(p.typing);
        if (t) row.typing = t.startsWith("dm:") ? "a direct message" : t;
        return row;
      }),
  },
  {
    name: "terminal_screen", read: true,
    description:
      "Read only: the screen and recent scrollback of the asker's terminal tabs shared with phosphorus on one host. " +
      "wait_s waits for new output (a login, a command finishing) before reading.",
    schema: object({ host: name, wait_s: { type: "integer", description: `seconds to wait for the screen to change, up to ${waitMaxS}`, default: 0 } }, "host"),
    run: async (a, m) => {
      const by = m.caller?.user ?? "";
      const host = knownHost(a);
      let w = jsNumber(a.wait_s);
      if (Number.isNaN(w) || w < 0) w = 0;
      const r = await watchScreens(host, Math.trunc(w), by);
      if (!arr(r.terminals).length && openedFor(by, host)) {
        r.state = "opened, waiting for login";
        r.note = "a terminal to " + host + " was opened on their page and isn't logged in yet; wait_s waits for it";
      }
      return r;
    },
  },
  {
    name: "files_list", read: true,
    description:
      "Files shared to the mesh. No host: every host's shares and perms at once. " +
      "Host only: that host's shares. With a share: its entries to depth levels (folders end in /), " +
      "match filtering names by a glob like *.jpg.",
    schema: object({
      host: { type: "string", description: "host name, as mesh_hosts lists it, blank for every host" },
      share: { type: "string", description: "share id from the shares list" },
      path: { type: "string", description: "folder in the share, blank for its root" },
      depth: { type: "integer", description: "levels to list, 1 to 8", default: 1 },
      match: { type: "string", description: "name glob, * and ?, case-insensitive" },
      stat: { type: "boolean", description: "path names one file or folder: whether it exists, its size and mtime", default: false },
    }),
    run: async (a, m) => {
      if (a.stat === true) return fileStat(a, m);
      if (!a.host) {
        const hosts = await Promise.all(
          meshHosts().map(async (h) => {
            const [st, body] = await src.actions.files(m.caller, h, "info", "", {});
            const b = obj(body) ?? {};
            if (st < 300) return { host: h, shares: b.shares ?? [] };
            return { host: h, error: str(b.error) || `status ${st}` };
          }),
        );
        return { hosts };
      }
      const host = knownHost(a);
      if (!a.share) return pressed(src.actions.files(m.caller, host, "info", "", {}));
      let depth = 1;
      if ("depth" in a) {
        depth = jsNumber(a.depth);
        if (Number.isNaN(depth) || depth < 1 || depth > 8) throw errc("bad_input", "depth is 1 to 8");
      }
      return pressed(src.actions.files(m.caller, host, "tree", str(a.share), { path: str(a.path), depth, match: str(a.match) }));
    },
  },
  {
    name: "files_read", read: true,
    description: "Read a text file in a share, as the files tab's preview does, a page at a time, from: the next page's offset.",
    schema: object({
      host: name, share: { type: "string" },
      path: { type: "string", description: "the file, relative to the share's root" },
      from: { type: "integer", description: "character offset to read from", default: 0 },
    }, "host", "share", "path"),
    run: async (a, m) => {
      const host = knownHost(a);
      const f = obj(await pressed(src.actions.files(m.caller, host, "read", str(a.share), { path: str(a.path) }))) ?? {};
      if (f.tooBig) return { path: f.path ?? null, size: f.size ?? null, note: "over 512KB: too big to read here" };
      if (f.binary) return { path: f.path ?? null, size: f.size ?? null, note: "a binary file, not text" };
      const u = [...str(f.text)];
      const from = Math.min(Math.trunc(Math.max(0, numOr(a.from, 0))), u.length);
      const end = Math.min(from + filePage, u.length);
      const out: Record<string, any> = { path: f.path ?? null, size: f.size ?? null, from, text: u.slice(from, end).join("") };
      if (end < u.length) out.next = end;
      return out;
    },
  },
  {
    name: "game_power",
    description: "Press play or stop on a game service, as its button does, runs only the start or stop command declared for it.",
    schema: object({ host: name, name: { type: "string" }, action: { type: "string", enum: ["start", "stop"] } }, "host", "name", "action"),
    run: (a, m) => {
      askerOf(m);
      const act = str(a.action);
      if ((act !== "start" && act !== "stop") || !gameNameRe.test(str(a.name))) throw new Error("bad name or action");
      return pressed(src.actions.game(knownHost(a), str(a.name), act));
    },
  },
  {
    name: "make_git_master",
    description:
      "The git card's make master: the live master hands off to this host, or with none it is force-promoted. " +
      "Returns once it leads (up to 30s), never press it again while one is under way.",
    schema: object({ host: name }, "host"),
    run: (a, m) => {
      adminOf(m);
      askerOf(m);
      return pressed(src.actions.gitMaster(knownHost(a)));
    },
  },
  {
    name: "set_agent_model",
    description:
      "Assign a mesh host's model to an agent, mesh-wide: the host as phosphorus/<host> (or just <host>), blank for the " +
      "automatic pick. slot fast is the small model an agent uses for background work (code, claude-code, opencode only).",
    schema: object({
      agent: { type: "string", enum: ["code", "claude-code", "opencode"] },
      slot: { type: "string", enum: ["model", "fast"] }, model: { type: "string" },
    }, "agent", "model"),
    run: (a, m) => {
      adminOf(m);
      askerOf(m);
      return pressed(src.actions.agentModel(str(a.agent), str(a.slot), str(a.model)));
    },
  },
  {
    name: "update_control",
    description: "Start a mesh update (an admin's key), or cancel the running one. " + noCreds,
    schema: object({
      action: { type: "string", enum: ["start", "cancel"] },
      hosts: { type: "array", items: { type: "string" }, description: "start only: just these hosts, to retry the ones that failed" },
    }, "action"),
    run: (a, m) => {
      adminOf(m);
      askerOf(m);
      const act = str(a.action);
      if (act !== "start" && act !== "cancel") throw new Error("action is start or cancel");
      // a chat ask starts one only through ask_credentials, its password
      if (act === "start" && !m.caller) throw new Error("starting one takes the update password: ask_credentials update");
      const only: string[] = [];
      for (const h of arr(a.hosts)) {
        if (!nameRe.test(str(h))) throw errc("bad_input", `bad host ${jsString(h)}`);
        only.push(str(h));
      }
      if (only.length && act !== "start") throw errc("bad_input", "hosts goes with start alone");
      return pressed(src.actions.update(act, !!m.caller?.admin, only));
    },
  },
  {
    name: "files_write",
    description:
      "Write a text file in a share with w: the whole file as text (made if missing), or old replaced by new, " +
      "old an exact passage found once in it. files_read it first to edit.",
    schema: object({
      host: name, share: { type: "string" },
      path: { type: "string", description: "the file, relative to the share's root" },
      text: { type: "string", description: "the whole file" },
      old: { type: "string", description: "the exact passage to replace" }, new: { type: "string", description: "what replaces it" },
      open: { type: "boolean", description: "also open the file in a editor tab on their page", default: false },
    }, "host", "share", "path"),
    run: async (a, m) => {
      const who = askerOf(m);
      const edit = typeof a.old === "string" && typeof a.new === "string";
      if (!edit && typeof a.text !== "string") throw new Error("give text, or old and new");
      const body: Record<string, any> = { path: str(a.path), by: { name: byOf(m), color: src.actions.modelColor } };
      if (edit) {
        body.old = a.old;
        body.new = a.new;
      } else body.text = a.text;
      const host = knownHost(a);
      const share = str(a.share);
      const out = obj(await pressed(src.actions.files(m.caller, host, "save", share, body))) ?? {};
      if (a.open === true) {
        const p = str(out.path) || str(body.path);
        if (await who.ui({ kind: "code", host, share, path: p })) out.opened = "in a editor tab on their page";
      }
      return out;
    },
  },
  {
    name: "files_change",
    description:
      "Organize a share within its perms: mkdir, rename or move (to ending in / moves into that folder, " +
      "missing folders made), delete (permanent). One change, or several in steps, run in order, stopping at the first failure.",
    schema: object({
      host: name, share: { type: "string" },
      op: { type: "string", enum: ["mkdir", "rename", "delete"] },
      path: { type: "string", description: "the folder to make, the entry to delete, or the one to rename" },
      to: { type: "string", description: "rename only: its new path, or a folder ending in /" },
      steps: {
        type: "array", description: "several changes in place of op, path and to",
        items: object({ op: { type: "string", enum: ["mkdir", "rename", "delete"] }, path: { type: "string" }, to: { type: "string" } }, "op", "path"),
      },
    }, "host", "share"),
    run: async (a, m) => {
      askerOf(m);
      const host = knownHost(a);
      let steps = arr(a.steps).slice(0, 200);
      if (!steps.length) steps = [{ op: a.op, path: a.path, to: a.to }];
      const done: Record<string, any>[] = [];
      for (const x of steps) {
        const st = obj(x) ?? {};
        const op = str(st.op);
        if (op !== "mkdir" && op !== "rename" && op !== "delete") throw errc("bad_input", "op is mkdir, rename or delete");
        if (!str(st.path)) throw errc("bad_input", "missing 'path'");
        if (op === "rename" && !str(st.to)) throw errc("bad_input", "missing 'to' for rename");
        const body = op === "rename" ? { from: str(st.path), to: str(st.to) } : { path: str(st.path) };
        const [status, out] = await src.actions.files(m.caller, host, op, str(a.share), body);
        const o = obj(out) ?? {};
        if (status >= 300) {
          const e = str(o.error) || `status ${status}`;
          throw new ToolError(codeOf(status), `${op} ${str(st.path)} failed: ${e}`, { done, failed: { ...st, error: e } });
        }
        const d: Record<string, any> = { op, path: st.path ?? null };
        if (o.path && op !== "delete") d.now = o.path;
        done.push(d);
      }
      if (steps.length === 1) return { ok: true, ...done[0] };
      return { done };
    },
  },
  {
    name: "open_file",
    description: "Open a text or code file from a share in a code editor tab on the asker's page, highlighted, its syntax errors marked, to read and edit together. Nothing in it can be run.",
    schema: object({ host: name, share: { type: "string" }, path: { type: "string", description: "the file, relative to the share's root" } }, "host", "share", "path"),
    run: async (a, m) => {
      const host = knownHost(a);
      const as = askerOf(m);
      await pressed(src.actions.files(m.caller, host, "read", str(a.share), { path: str(a.path) }));
      if (!(await as.ui({ kind: "code", host, share: str(a.share), path: str(a.path) }))) throw errc("unreachable", "no Phosphorus window of theirs is open");
      return { opened: host + "/" + jsString(a.path) };
    },
  },
  {
    name: "open_terminal",
    description:
      "Open a terminal tab to a phosphorus host on the asker's page, shared with phosphorus from the start. " +
      "They log in themselves, phosphorus never types into it. " + noCreds,
    schema: object({ host: name }, "host"),
    run: async (a, m) => {
      const host = knownHost(a);
      const as = askerOf(m);
      if (!(await as.ui({ kind: "terminal", host, share: true }))) throw errc("unreachable", "no Phosphorus window of theirs is open");
      noteOpened(as.name, host);
      return { opened: host, state: "opened, waiting for login", note: "it shares with phosphorus once they log in; terminal_screen with wait_s reads it then" };
    },
  },
  {
    name: "chat_history", read: true,
    description: "",
    schema: object({
      limit: { type: "integer", description: `lines, at most ${chatMax}`, default: 20 },
      channel: { type: "string", description: "one channel only: mesh for the main one, or dm:<name>" },
      wait_s: { type: "integer", description: `key only: wait up to this many seconds (max ${chatWaitMax}) for lines newer than since`, default: 0 },
      since: { type: "integer", description: "with wait_s: only lines after this ms, default now" },
    }),
    run: (a, m) => {
      const want = str(a.channel).replace(/^#/, "");
      channelKnown(m, want);
      if (numOr(a.wait_s, 0) > 0) {
        if (!m.caller) throw errc("forbidden", "wait_s on a user's key only");
        return chatWait(a, m, want);
      }
      let n = 20;
      if ("limit" in a) {
        const x = jsNumber(a.limit);
        if (Number.isNaN(x) || x < 1 || x > chatMax) throw errc("bad_input", `limit is 1 to ${chatMax}`);
        n = Math.trunc(x);
      }
      const lines = chatRows(m, want);
      return lines.length > n ? lines.slice(lines.length - n) : lines;
    },
  },
  {
    name: "send_message",
    description:
      "Post as yourself to the mesh group chat, or as a direct message to one person by their chat name, " +
      "for when the asker wants someone else told something. Never needed to answer the asker.",
    schema: object({
      text: { type: "string", description: "the message, markdown" },
      to: { type: "string", description: "a person's chat name for a direct message, blank for the group chat" },
    }, "text"),
    run: (a, m) => {
      askerOf(m);
      const to = str(a.to).trim().replace(/^@/, "");
      if (to && !src.known(to)) throw notKnown(to);
      return pressed(src.post(byOf(m), to, str(a.text), viaOf(m)));
    },
  },
  {
    name: "show_file",
    description:
      "Invite a person into a share's file in the editor, as /share does: a dialog and a notification for them, " +
      "open in a tab on accepting. For when the asker wants someone to look at or work on a file with them.",
    schema: object({
      to: { type: "string", description: "the person's chat name" },
      host: name, share: { type: "string" }, path: { type: "string", description: "the file, relative to the share's root" },
    }, "to", "host", "share", "path"),
    run: async (a, m) => {
      askerOf(m);
      const host = knownHost(a);
      const to = str(a.to).trim().replace(/^@/, "");
      if (!src.known(to)) throw notKnown(to);
      const p = str(a.path);
      await pressed(src.actions.files(m.caller, host, "read", str(a.share), { path: p }));
      return pressed(src.show(byOf(m), to, { host, share: str(a.share), path: p, label: host + "/" + p }));
    },
  },
  {
    name: "update_status", read: true,
    description: "The mesh update: whether one is running, who started it, and each host's result.",
    schema: object({ history: { type: "boolean", default: false, description: "key only: also the last fifty updates started from this host, each host's result and error" } }),
    run: async (a, m) => {
      const out: Record<string, any> = { lock: src.lock(), chain: src.chain() };
      if (a.history === true) {
        if (!m.caller) throw errc("forbidden", "history on a user's key only");
        out.history = await pressed(src.actions.op("", "update_history", undefined));
      }
      return out;
    },
  },
];
