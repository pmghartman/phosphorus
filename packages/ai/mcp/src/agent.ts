// the tools for an agent outside the mesh, on a user's key, and every tool's
// description written for one: what it does, what it returns, what to use next
import { obj } from "@phosphorus/util";
import {
  adminOf,
  arr,
  askerOf,
  codeOf,
  errc,
  jsString,
  knownHost,
  type Loc,
  type Meta,
  meshHosts,
  name,
  nameRe,
  numOr,
  object,
  pressed,
  src,
  str,
  type Tool,
  ToolError,
  tools,
} from "./common.ts";

const loc = (what: string) =>
  object(
    {
      host: { type: "string", description: what + " host, as mesh_hosts lists it" },
      share: { type: "string", description: "share id, from files_list" },
      path: { type: "string", description: "the file, relative to the share's root" },
    },
    "host",
    "share",
    "path",
  );

function locOf(v: unknown): Loc {
  const o = obj(v);
  const l: Loc = [str(o?.host), str(o?.share), str(o?.path)];
  if (!nameRe.test(l[0]) || !l[1] || !l[2]) throw new Error("each of from and to needs host, share and path");
  return l;
}

const errOf = (b: unknown) => str(obj(b)?.error);

export const agentTools = (): Tool[] => [
  {
    name: "files_search",
    title: "Search files",
    read: true,
    description:
      "Find files by name, or by text inside them, across every host's shares at once or one host and share. " +
      "Case-insensitive; content searches read text files up to 1MB and return each file's first matching lines. " +
      "Use it before files_read when you don't know where something lives. Home (the merged per-user share) only on a key, and only your own part.",
    schema: object({
      query: { type: "string", description: "text to find in names, or in contents with content" },
      content: { type: "boolean", description: "search inside files, not names", default: false },
      glob: { type: "string", description: "only names matching, like *.go or *.md" },
      host: { type: "string", description: "one host, blank for every host" },
      share: { type: "string", description: "one share id, blank for all of the host's" },
      path: { type: "string", description: "a folder to search under, with share" },
    }),
    run: async (a, m) => {
      const hosts = str(a.host) ? [knownHost(a)] : meshHosts();
      const body = { query: a.query, content: a.content === true, glob: a.glob, path: a.path };
      const out: Record<string, any>[] = [];
      for (const h of hosts) {
        let shares: string[] = [];
        if (str(a.share)) shares = [str(a.share)];
        else {
          const [st, b] = await src.actions.files(m.caller, h, "info", "", {});
          if (st >= 300) continue;
          for (const x of arr(obj(b)?.shares)) {
            const id = str(obj(x)?.id);
            if (id === "home" && !m.caller) continue;
            shares.push(id);
          }
        }
        for (const sh of shares) {
          const [st, b] = await src.actions.files(m.caller, h, "search", sh, body);
          const r = obj(b) ?? {};
          if (st >= 300) {
            out.push({ host: h, share: sh, error: r.error ?? null });
            continue;
          }
          const rs = arr(r.results);
          if (rs.length || r.truncated === true) {
            const row: Record<string, any> = { host: h, share: sh, results: rs };
            if (r.truncated === true) row.truncated = true;
            out.push(row);
          }
        }
      }
      return { found: out };
    },
  },
  {
    name: "files_copy",
    title: "Copy or move files",
    destructive: true,
    description:
      "Copy a file or a whole folder from a share to a share, on the same host or across hosts, any size and any kind " +
      "(binary too), streamed host to host. move deletes the original once the copy lands. An existing file at to is replaced.",
    schema: object({ from: loc("source"), to: loc("target"), move: { type: "boolean", default: false } }, "from", "to"),
    run: async (a, m) => {
      askerOf(m);
      const from = locOf(a.from),
        to = locOf(a.to);
      for (const h of [from[0], to[0]]) knownHost({ host: h });
      // a folder: its tree walked, folders made, each file copied
      const [st, b] = await src.actions.files(m.caller, from[0], "tree", from[1], { path: from[2], depth: 8 });
      if (st >= 300) {
        const e = errOf(b);
        if (e !== "not a directory") throw new ToolError(codeOf(st), e);
        return pressed(src.actions.copy(m.caller, from, to, a.move === true));
      }
      return copyFolder(m, from, to, obj(b) ?? {}, a.move === true);
    },
  },
  {
    name: "host_logs",
    title: "Host logs",
    read: true,
    scope: "key",
    description:
      "A host's logs: phosphorus's own (systemd's journal on Linux, phosphorus.log elsewhere), one part of it, " +
      "or a game's start/stop output; the last lines, filtered. The first stop when something misbehaves. Admins only.",
    schema: object(
      {
        host: name,
        lines: { type: "integer", description: "how many, up to 2000", default: 200 },
        match: { type: "string", description: "only lines holding this, case-insensitive" },
        source: {
          type: "string",
          description: "phosphorus (all, default), frontend, cloudflared, git, model, mesh, game:<name>",
        },
        level: {
          type: "string",
          enum: ["error", "warn"],
          description: "only lines that read as errors, or as errors and warnings",
        },
        since: { type: "string", description: "RFC3339, a date, or an age like 30m, 2h, 1d" },
        until: { type: "string", description: "as since" },
      },
      "host",
    ),
    run: (a, m) => {
      adminOf(m);
      const h = knownHost(a);
      return pressed(
        src.actions.logs(h, {
          lines: numOr(a.lines, 200),
          match: a.match,
          source: a.source,
          level: a.level,
          since: a.since,
          until: a.until,
        }),
      );
    },
  },
  {
    name: "host_config",
    title: "Read host config",
    read: true,
    scope: "key",
    description:
      "A host's two config files as they stand: phosphorus.ini (shares in [files], [git], [model], [home]) and " +
      "services.export (each [service]: port, scheme, mode, base_path, public, type game with start/stop). Read before service_edit or config_set. Admins only.",
    schema: object({ host: name }, "host"),
    run: (a, m) => {
      adminOf(m);
      return pressed(src.actions.config(knownHost(a), { op: "get" }));
    },
  },
  {
    name: "service_edit",
    title: "Edit a service",
    scope: "key",
    destructive: true,
    description:
      "Publish, change or remove a service in a host's services.export, as the terminal UI's form does, the whole file " +
      "checked before it's written and live within seconds. fields only change the keys given; a blank value drops one. " +
      "Web: port (required), scheme http|https, mode path|subdomain, base_path, public true. Game: type game, port, start and stop commands. Admins only.",
    schema: object(
      {
        host: name,
        name: { type: "string", description: "the service, lowercase letters, digits and -" },
        fields: {
          type: "object",
          description: 'keys to set, e.g. {"port":"8096","public":"true"}',
          additionalProperties: { type: "string" },
        },
        remove: { type: "boolean", default: false },
        dry_run: { type: "boolean", description: "return the diff alone, nothing written", default: false },
      },
      "host",
      "name",
    ),
    run: (a, m) => {
      adminOf(m);
      const h = knownHost(a);
      return pressed(
        src.actions.config(h, { op: "service", name: a.name, fields: a.fields, remove: a.remove, dry_run: a.dry_run }),
      );
    },
  },
  {
    name: "config_set",
    title: "Set host config",
    scope: "key",
    destructive: true,
    description:
      "Set one key of a host's phosphorus.ini, blank value to drop it (a section left empty goes too); phosphorus applies it within seconds. " +
      "Keys: [files] dir and priv (the shares and their rwd perms, comma-separated in step), [git] host, [model] host/gpu/url/ctx/slots, [home] dir. " +
      "Read host_config first and keep the other values. Admins only.",
    schema: object(
      {
        host: name,
        section: { type: "string", enum: ["files", "git", "model", "home"] },
        key: { type: "string" },
        value: { type: "string" },
        dry_run: { type: "boolean", description: "return the diff alone, nothing written", default: false },
      },
      "host",
      "section",
      "key",
      "value",
    ),
    run: (a, m) => {
      adminOf(m);
      const h = knownHost(a);
      return pressed(
        src.actions.config(h, { op: "ini", section: a.section, key: a.key, value: a.value, dry_run: a.dry_run }),
      );
    },
  },
  {
    name: "service_request",
    title: "Call a service's API",
    scope: "key",
    open: true,
    description:
      "One HTTP request to a web service published on the mesh, straight to it over the tailnet, past phosphorus's login: " +
      "its API by path. headers carry the service's own auth when it wants one (e.g. an API token the person gave you). " +
      "Returns status, content type and the body as json or text, up to 512KB.",
    schema: object(
      {
        service: { type: "string", description: "the service's name, from services" },
        host: { type: "string", description: "its host, when several publish the name" },
        method: { type: "string", default: "GET" },
        path: { type: "string", description: "under the service's root, with any query" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string", description: "the request body, JSON as text" },
      },
      "service",
      "path",
    ),
    run: (a, m) => {
      askerOf(m);
      const hs: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj(a.headers) ?? {})) hs[k] = jsString(v);
      return pressed(src.actions.service(str(a.host), str(a.service), str(a.method), str(a.path), hs, str(a.body)));
    },
  },
];

// copyFolder a tree from files_list's tree op copied under to, then the source
// removed when move and every file landed
async function copyFolder(
  m: Meta,
  from: Loc,
  to: Loc,
  tree: Record<string, any>,
  move: boolean,
): Promise<Record<string, any>> {
  if (tree.truncated === true)
    throw errc("bad_input", `${from[2]} holds too many entries to copy at once, copy its subfolders`);
  const base = from[2].replace(/\/$/, "");
  const dst = to[2].replace(/\/$/, "");
  const [st, b] = await src.actions.files(m.caller, to[0], "mkdir", to[1], { path: dst });
  if (st >= 300 && st !== 409) throw new ToolError(codeOf(st), "can't make " + dst + ": " + errOf(b));
  const copied: string[] = [],
    failed: Record<string, any>[] = [];
  for (const e of arr(tree.entries)) {
    const p = str(obj(e)?.path);
    const rel = (p.startsWith(base) ? p.slice(base.length) : p).replace(/^\//, "");
    if (p.endsWith("/")) {
      await src.actions.files(m.caller, to[0], "mkdir", to[1], { path: dst + "/" + rel.replace(/\/$/, "") });
      continue;
    }
    const [st, b] = await src.actions.copy(m.caller, [from[0], from[1], p], [to[0], to[1], dst + "/" + rel], false);
    if (st >= 300) {
      failed.push({ path: p, error: errOf(b) });
      continue;
    }
    copied.push(p);
  }
  const out: Record<string, any> = { folder: dst, copied: copied.length };
  if (failed.length) {
    throw new ToolError(
      "failed",
      `${failed.length} of ${failed.length + copied.length} files failed, the source kept`,
      { copied, failed },
    );
  }
  if (move) {
    const [st, b] = await src.actions.files(m.caller, from[0], "delete", from[1], { path: base });
    if (st >= 300) out.note = "copied, the original left: " + errOf(b);
    else out.moved = true;
  }
  return out;
}

// describe every tool's text, written for an agent
export function describe() {
  const d: Record<string, string> = {
    mesh_hosts:
      "Start here. Every device on the mesh's tailnet: name, OS, whether it runs phosphorus (only those are hosts you can act on), " +
      "plus this host and the mesh's domain. Host names from here are what every other tool's host takes. " +
      "health true adds each phosphorus host's health: answering, version, round trip in ms and its Cloudflare tunnel.",
    services:
      "Every web service and game server published on the mesh: host, name, port, mode, public, and the URL a person opens. " +
      "With host and name, that one service checked right now instead: listening, its HTTP status, published or why not. " +
      "service_request calls one's API; game_power starts or stops a game.",
    host_stats:
      "One host right now: cpu, memory and disk with percents, gpu, network, phosphorus's own parts by role and the top processes. " +
      "No host: one row of percents per host at once, the cheap way to scan the mesh before drilling into one.",
    git: "The git (Forgejo) hosts: which is master, which are replicas, how far behind each is, reachable or not.",
    files_list:
      "Browse files shared to the mesh. No host: every host's shares and their rwd perms. A host: its shares. A host and share: " +
      "entries to depth levels (folders end in /), match a name glob like *.jpg. stat true with a path: that one file or folder's " +
      "existence, size and mtime, cheaper than reading it. files_search finds things across everything at once.",
    files_read:
      "Read a text file from a share, 12000 characters a page; from is the next page's offset when there's more. Binary and over-512KB files are only described.",
    files_write:
      "Write a text file in a share with w perm: text for the whole file (made if missing), or old and new to replace one exact passage " +
      "found once in it (read it first).",
    files_change:
      "Organize a share within its perms: mkdir, rename or move (to ending in / moves into that folder), delete (permanent). " +
      "Several in steps run in order and stop at the first failure.",
    chat_history:
      "The last chat lines, oldest first: channels (mesh is the main one), and on a key your own direct messages as dm:<name>. " +
      "Each line has its ms. On a key, wait_s waits for lines newer than since (that ms), returning as soon as one lands: " +
      "for a reply after send_message.",
    send_message:
      "Post to the mesh chat, or a direct message to one person by their chat name. On a key it's posted as you.",
    open_file:
      "Open a share's text or code file in a editor tab on the person's Phosphorus window (on a key, every window of yours that's open). " +
      "Highlighted, syntax errors marked; nothing in it runs.",
    open_terminal:
      "Open a terminal tab to a host on the person's Phosphorus window, shared with phosphorus. On a key it logs in with their saved login for that host (none saved: nothing opens); terminal_run then runs commands in it. Else they log in themselves.",
    show_file:
      "Invite a person into a share's file in the editor: they get a dialog and a notification, and it opens in a tab on accepting.",
    terminal_screen:
      "Read the screen and recent scrollback of the person's terminal tabs that are shared with phosphorus on one host. wait_s waits for new output first.",
    game_power: "Start or stop a game server, running only the start or stop command its service declares.",
    update_status:
      "The mesh update: whether one runs, who started it, each host's step and result. history true adds the last fifty started from this host with any errors.",
    update_control:
      "Start a mesh update on an admin's key, or cancel the running one. update_status follows it. Admins only.",
    make_git_master:
      "Make a git host the master: the live one hands off, or with none it's force-promoted. Returns once it leads (up to 30s); never press it twice. Admins only.",
    set_agent_model:
      "Assign a mesh host's model to an agent (code, claude-code, opencode; tavern while the tavern app is on the mesh), mesh-wide: phosphorus/<host>, blank for the automatic pick; slot fast is the small background model. Admins only.",
    models:
      "The models: each agent's mesh host assigned and answering, each mesh model host's file, state and memory, and the last call's context use.",
    people: "Who is on phosphorus right now: each person, the host serving them, and whether they are typing.",
  };
  for (const t of tools) {
    if (d[t.name]) t.description = d[t.name]!;
    if (
      [
        "make_git_master",
        "set_agent_model",
        "update_control",
        "host_logs",
        "host_config",
        "service_edit",
        "config_set",
      ].includes(t.name)
    )
      t.admin = true;
    if (["files_change", "game_power", "update_control", "make_git_master"].includes(t.name)) t.destructive = true;
    else if (t.name === "fetch_page") t.open = true;
  }
}
