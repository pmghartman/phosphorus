// each tab drawn from the api's state and the config files, as the frontend's
// pages draw them
import { parse } from "@phosphorus/services";
import { FrontendPort } from "@phosphorus/util";
import { fieldsOf, isHomeDir, readGitHost, readHomeDir, readModel, readShares, readText, servicesFile, splitSections } from "@phosphorus/config";
import { type Card, type Key, type Row, bg, bold, c, caret, fg, gradient, inner, max0, off, pad, pal, panels, plainRows, strike, surface, table, vlen, wrap } from "./draw.ts";
import type { Field, Form } from "./form.ts";
import { type J, anys, get, indexOf, num, obj, objs, or, str, strs, truthy } from "./json.ts";
import { joinNote, keysNote, keysNoteApply } from "./keys.ts";
import { filesTab, gitTab, iniNote, modelNote, modelTab, rebuilding, servicesTab, shown, tabs, ui, updateTab } from "./state.ts";

export type View = {
  lines: string[];
  keys: Key[];
  scroll?: boolean;
  // the window title, the tab's name when blank
  title?: string;
};

export const baseDomain = process.env.BASE_DOMAIN ?? "";

export const k = (label: string, kind = ""): Key => ({ label, kind });

// kif the key when cond holds, else nothing
export const kif = (cond: boolean, label: string, kind = ""): Key => (cond ? k(label, kind) : { label: "", kind: "" });

export function clampSel(i: number, n: number): number {
  if (i > n - 1) i = n - 1;
  if (i < 0) i = 0;
  return i;
}

export const selfHost = () => str(get(ui.state, "self", "host"));

// the domain, else this host's name on the tailnet
const meshAddr = () => baseDomain || selfHost();

// topBar .dk-bar at the top: the wordmark, the apps as tabs, the hosts and
// the version right, narrowed by dropping the hosts, then the tab names
export function topBar(cols: number): string {
  const mark = " " + gradient("phosphorus", 0) + "  ";
  if (ui.keysOnly) return surface(pal.tabbar!)(mark + c("muted")("· ") + c("sage")("keys") + " ".repeat(max0(cols - vlen(mark) - 6)));
  const tasks = (short: boolean) =>
    tabs
      .slice(0, shown)
      .map((t, i) => {
        const label = short ? ` ${i + 1} ` : ` ${i + 1} ${t} `;
        if (i === ui.tab) return surface(pal.border!)(bold(fg(pal.accent!) + label.slice(0, 2) + fg(pal.fg!) + label.slice(2)));
        return c("muted")(label);
      })
      .join("");
  const ver = ui.state ? c("dim")("v" + str(get(ui.state, "self", "version"))) + " " : "";
  // a mesh update running, lit from any tab; the update view's own name when open
  let upd = "";
  if (ui.tab === updateTab) upd = surface(pal.border!)(bold(c("accent")(" mesh update "))) + "  ";
  else if (obj(get(ui.state, "lock"))) upd = c("accent")("● updating") + "  ";
  let chips = hostChips();
  if (chips !== "") chips += "  ";
  let t = tasks(false);
  for (const right of [upd + chips + ver, upd + ver]) {
    if (vlen(mark) + vlen(t) + vlen(right) <= cols) return surface(pal.tabbar!)(mark + t + " ".repeat(cols - vlen(mark) - vlen(t) - vlen(right)) + right);
  }
  t = tasks(true);
  let right = upd + ver;
  if (vlen(mark) + vlen(t) + vlen(right) > cols) right = upd;
  return surface(pal.tabbar!)(mark + t + " ".repeat(max0(cols - vlen(mark) - vlen(t) - vlen(right))) + right);
}

// .dk-chip: this host purple, the rest green, one not answering red
function hostChips(): string {
  if (!ui.state) return "";
  const self = selfHost();
  const chips = [c("accent")("■") + " " + self];
  for (const d of objs(ui.state.tailnet)) {
    const n = str(d.name);
    if (n === self || n === "") continue;
    if (truthy(d.phosphorus)) chips.push(c("online")("■") + " " + c("muted")(n));
    else if (truthy(d.phosphorusSeen)) chips.push(c("offmesh")("■") + " " + c("offmesh")(n));
  }
  return chips.join("  ");
}

const kindTok: Record<string, string> = { primary: "accent", danger: "offmesh", quiet: "muted" };

// hints one line: a view's keys left, the global ones right, the key letter
// in its kind's colour, the rest muted
export function hints(keys: Key[], global: Key[], cols: number): string {
  const one = (ks: Key[]) =>
    ks
      .filter((x) => x.label !== "")
      .map((x) => {
        const tok = kindTok[x.kind] || "fg";
        const sp = x.label.indexOf(" ");
        const [key, rest] = sp < 0 ? [x.label, ""] : [x.label.slice(0, sp), x.label.slice(sp + 1)];
        return bold(c(tok)(key)) + " " + c("muted")(rest);
      })
      .join("   ");
  const left = " " + one(keys), right = one(global) + " ";
  return left + " ".repeat(max0(cols - vlen(left) - vlen(right))) + right;
}

// .is-self and .mesh-stat-dot: the square before a host's name
const selfMark = (name: string) => c("accent")("■") + " " + name;

const dot = (d: J) => c(truthy(d.phosphorus) ? "teal" : "dim")("■") + " " + str(d.name);

function servicesView(): View {
  const st = ui.state!;
  const text = readText(servicesFile);
  const d = splitSections(text);
  const [, perr] = parse(text);
  const own: Record<string, J> = {};
  for (const r of objs(st.routes)) if (str(r.host) === selfHost()) own[str(r.name)] = r;
  ui.sel[servicesTab] = clampSel(ui.sel[servicesTab]!, d.secs.length);
  const rows: string[][] = [];
  for (const s of d.secs) {
    const f = fieldsOf(s);
    const live = own[s.name];
    const ok = live !== undefined;
    let status: string;
    if (f.type === "game" && ok && str(live.status) === "online") status = c("online")(str(live.status));
    else if (f.type === "game" && ok) status = c("warn")(str(live.status));
    else if (f.type === "game") status = c("muted")("not published");
    else if (ok) status = c("online")("published");
    else status = c("warn")("not answering");
    let where = `${meshAddr()}/${selfHost()}/${s.name}/`;
    if (f.type === "game") where = `${s.name}.${str(st.gameZone)}:${f.port ?? ""}`;
    else if (f.mode === "subdomain" && baseDomain !== "") where = s.name + "." + baseDomain;
    let scheme = f.scheme ?? "";
    if (scheme === "" && !f.type) scheme = "http";
    let access = c("muted")("login");
    if (f.type === "game") access = c("muted")("-");
    else if (f.public === "true") access = c("warn")("public");
    rows.push([s.name, f.port ?? "", c("teal")(or(f.type ?? "", f.mode ?? "", "path")), c("muted")(scheme), c("muted")(where), access, status]);
  }
  let rejected: Card | undefined;
  let room = ui.room - 3;
  if (perr !== "") {
    rejected = { title: "rejected", lines: plainRows(c("offmesh")(perr), c("offmesh")("the frontend keeps publishing the last good version until it is fixed")) };
    room = ui.room - 8;
  }
  let body = plainRows(c("muted")("no services declared"));
  if (rows.length > 0) body = table(["name", "port", "mode", "scheme", "address", "access", "live"], rows, ui.sel[servicesTab]!, room);
  const n = rows.length > 0;
  return { lines: panels(rejected, { title: "services.export", lines: body }), keys: [k("a add", "primary"), kif(n, "e edit"), kif(n, "d delete", "danger")] };
}

const star = (on: boolean) => (on ? c("accent")("★") : " ");

function filesView(): View {
  const shares = readShares();
  const info = ui.filesInfo;
  const home = readHomeDir();
  ui.sel[filesTab] = clampSel(ui.sel[filesTab]!, shares.length);
  let published: Card | undefined;
  if (info && info.shares != null) {
    const ls: string[] = [];
    for (const s of objs(info.shares)) ls.push(`${star(truthy(s.home))} ${str(s.label)}  ${c("teal")(str(s.perms))}`);
    if (ls.length === 0) ls.push(c("muted")("nothing"));
    const w = str(info.wantDir);
    if (w !== "") ls.push("", c("warn")(rebuilding + " to publish " + w));
    published = { title: "published now", lines: plainRows(...ls) };
  }
  let fallback = "files/ beside the app";
  if (info && str(info.home) !== "") fallback = str(info.home);
  let lines: Row[] = [];
  let anyHome = false;
  if (shares.length > 0) {
    const rs = shares.map((s) => {
      const h = isHomeDir(s.dir);
      anyHome = anyHome || h;
      return [star(h), s.dir, c("teal")(s.perms)];
    });
    lines = table(["", "dir", "perms"], rs, ui.sel[filesTab]!, 0);
  }
  if (home === "" || !anyHome) {
    const lead = shares.length > 0 ? "  " : "";
    lines.push({ text: lead + star(true) + " " + c("muted")(fallback) + " " + c("muted")("(default)") });
  }
  lines.push(...plainRows("", c("muted")("★ holds home/: each user's folder, shared/ and .sys/")));
  const n = shares.length > 0;
  return {
    lines: panels({ title: "phosphorus.ini [files]", lines }, published),
    keys: [k("a add", "primary"), kif(n, "e edit"), kif(n, "d delete", "danger"), kif(n, "h home")],
  };
}

const gib = 1 << 30;

const gb = (bytes: number) => (bytes / gib).toFixed(1) + "GB";

export function ago(sec: number): string {
  const s = Math.trunc(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.trunc(s / 60)}m`;
  if (s < 86400) return `${Math.trunc(s / 3600)}h`;
  return `${Math.trunc(s / 86400)}d`;
}

// the git card's age since the master's stamp was last matched (data copied only on change):
// five cells a band, green to 8s, yellow to 15s, red to 60s
export function lagMeter(age: number): string {
  let out = "";
  let empty = 0;
  for (const [tok, from, to] of [["online", 0, 8], ["warn", 8, 15], ["offmesh", 15, 60]] as [string, number, number][]) {
    const full = Math.round(Math.max(0, Math.min(1, (age - from) / (to - from))) * 5);
    if (full > 0) out += c(tok)("█".repeat(full));
    empty += 5 - full;
  }
  return out + fg(off) + "░".repeat(empty) + fg(pal.fg!);
}

// the card's glyphs: ● master, ○ servant ready, ◌ catching up, × unreachable
function gitRow(h: J, masterGen: any): string[] {
  const master = str(h.role) === "master";
  const reach = truthy(h.reachable);
  let glyph: string;
  if (!reach) glyph = c("offmesh")("×");
  else if (master) glyph = c("accent")("●");
  else if (!truthy(h.eligible)) glyph = c("sand")("◌");
  else glyph = c("sage")("○");
  let name = str(h.host);
  if (!reach) name = c("muted")(strike(name));
  let backup: string;
  if (!reach) backup = "unreachable";
  else if ((h.gen == null || h.ageSec == null) && masterGen != null && !master) backup = c("sand")("downloading…");
  else if (h.gen == null || h.ageSec == null) backup = "no data yet";
  else {
    let first = ago(num(h.ageSec)) + " behind";
    if (master) first = "live";
    else if (masterGen != null && num(h.gen) < num(masterGen)) first = "older lineage";
    const parts = [first];
    if (!master && !truthy(h.eligible)) parts.push("catching up");
    if (truthy(h.updating)) parts.push("updating");
    backup = parts.join(" · ");
  }
  let meter = "";
  if (reach && !master && h.ageSec != null) meter = lagMeter(num(h.ageSec));
  return [glyph + " " + name, c("muted")(backup), meter];
}

// .mesh-stat-ping: green to 40ms, yellow to 150, red past it
export function ping(ms: unknown): string {
  if (typeof ms !== "number") return c("muted")("–");
  const n = Math.round(ms);
  const tok = n <= 40 ? "online" : n <= 150 ? "warn" : "offmesh";
  return c(tok)(`${n}ms`);
}

function statsView(): View {
  const st = ui.state!;
  const self = selfHost();
  let lockCard: Card | undefined;
  const lock = obj(st.lock);
  if (lock) lockCard = { title: "mesh update", lines: plainRows(c("accent")("running, started by " + str(lock.initiator))) };
  let tail = objs(st.tailnet);
  if (!tail.some((d) => str(d.name) === self)) tail = [{ name: self, phosphorus: true }, ...tail];
  const trows: string[][] = [];
  for (const d of tail) {
    const isSelf = str(d.name) === self;
    let name = dot(d), os = str(d.os), ver = str(d.version), p = "";
    if (isSelf) {
      name = selfMark(self);
      os = str(get(st, "self", "platform"));
      ver = str(get(st, "self", "version"));
    }
    if (isSelf || truthy(d.phosphorus)) p = ping(ui.rtt[str(d.name)]);
    trows.push([name, c("teal")(os), c("muted")(ver), p]);
  }
  const routes = objs(st.routes);
  let rbody = plainRows(c("muted")("nothing published"));
  if (routes.length > 0) {
    const rrows: string[][] = [];
    for (const r of routes) {
      const game = str(r.type) === "game";
      let mode = str(r.mode), addr = "", status = c("online")("up");
      if (game) {
        mode = "game";
        addr = `${str(r.name)}.${str(st.gameZone)}:${str(r.port)}`;
      } else if (mode === "subdomain" && baseDomain !== "") {
        addr = str(r.name) + "." + baseDomain;
        const bp = str(r.base_path);
        if (bp !== "") addr += "/" + bp;
      } else addr = `${meshAddr()}/${str(r.host)}/${str(r.name)}/`;
      if (game) status = c(str(r.status) === "online" ? "online" : "muted")(str(r.status));
      let access = c("muted")("login");
      if (r.public === true || r.master != null) access = c("warn")("public");
      if (game) access = c("muted")("-");
      rrows.push([c("sky")(str(r.host)), str(r.name), c("teal")(mode), c("muted")(addr), c("muted")(str(r.port)), access, status]);
    }
    rbody = table(["host", "name", "mode", "address", "port", "access", "status"], rrows, -1, 0);
  }
  return {
    lines: panels(lockCard, overview(tail), { title: "tailnet", lines: table(["host", "os", "version", "ping"], trows, -1, 0) }, { title: "routes", lines: rbody }),
    keys: [k("↑↓ scroll", "quiet")],
    scroll: true,
  };
}

// overview where to open the desktop and how many hosts answer
function overview(tail: J[]): Card {
  let up = 0, seen = 0;
  for (const d of tail) {
    if (truthy(d.phosphorus)) up++;
    if (truthy(d.phosphorus) || truthy(d.phosphorusSeen)) seen++;
  }
  const addr = baseDomain !== "" ? "https://" + baseDomain : "http://" + selfHost();
  const tok = up < seen ? "warn" : "online";
  const lbl = (s: string) => c("muted")(s.padEnd(6));
  return {
    title: "this mesh",
    lines: plainRows(
      lbl("open") + c("accent")(addr) + c("muted")("  in a browser on the tailnet"),
      lbl("hosts") + c(tok)(`${up} of ${seen}`) + c("muted")(" answering"),
    ),
  };
}

// phosphorus.ini's flag against what the mesh sees, the election as the git card draws it
function gitView(): View {
  const st = ui.state!;
  const want = readGitHost();
  const hosts = objs(st.gitHosts);
  let live = false;
  let masterGen: any = undefined;
  for (const h of hosts) {
    live = live || str(h.host) === selfHost();
    if (masterGen == null && str(h.role) === "master") masterGen = h.gen;
  }
  ui.sel[gitTab] = clampSel(ui.sel[gitTab]!, hosts.length);
  const on = want ? c("online")("on") : c("muted")("off");
  const here = plainRows(selfMark(selfHost()) + "  git host " + on);
  if (want !== live) here.push({ text: c("warn")((want ? "not a git host yet" : "still a git host") + "; " + rebuilding) });
  let body = plainRows(c("muted")("none"));
  if (hosts.length > 0) body = table(["host", "state", "behind"], hosts.map((h) => gitRow(h, masterGen)), ui.sel[gitTab]!, 0);
  const target = ui.sel[gitTab]! < hosts.length ? hosts[ui.sel[gitTab]!] : undefined;
  return {
    lines: panels({ title: "this host", lines: here }, { title: "git hosts", lines: body }),
    keys: [k("h toggle host", "primary"), kif(!!target && truthy(target.reachable) && str(target.role) !== "master", "p make master")],
  };
}

// the agents asking a model host's model, as the frontend assigns them
const agentsOf = (x: J) => anys(x.agents).map(str);

function modelView(): View {
  const st = ui.state!;
  const model = obj(st.model) ?? {};
  const all = objs(model.models);
  let m: J | undefined;
  let mi = -1;
  all.forEach((x, i) => {
    if (!m && str(x.host) === selfHost()) {
      m = x;
      mi = i;
    }
  });
  const cfg = readModel();
  // starts on this host's own row
  if (!ui.modelPicked && m) {
    ui.sel[modelTab] = mi;
    ui.modelPicked = true;
  }
  ui.sel[modelTab] = clampSel(ui.sel[modelTab]!, all.length);
  const rows: string[][] = [];
  for (const x of all) {
    let name = c("teal")("■") + " " + str(x.host);
    if (str(x.host) === selfHost()) name = selfMark(str(x.host));
    let agents = c("dim")("-");
    const as = agentsOf(x);
    if (as.length > 0) agents = c("accent")(as.join(" + "));
    const dl = obj(x.download);
    let state: string;
    if (truthy(x.ready)) state = c("online")("loaded");
    else if (dl && truthy(dl.total)) state = c("sand")(`${Math.floor((100 * num(dl.done)) / num(dl.total))}%`);
    else if (truthy(x.loading)) state = c("sand")("loading");
    else state = c("warn")("down");
    let speed = c("dim")("-");
    const tps = get(x, "use", "tps");
    if (truthy(x.ready) && truthy(tps)) speed = str(tps) + " tok/s";
    let file = c("dim")("no link");
    const fname = str(x.file);
    if (fname !== "") file = c("muted")(fname);
    rows.push([name, agents, state, speed, file]);
  }
  const hostOn = cfg.host === "true";
  let first = selfMark(selfHost()) + "  model host ";
  if (hostOn) first += c("online")("on") + "  " + c("muted")("gpu " + cfg.gpu + " · slots " + or(cfg.slots!, "4"));
  else first += c("muted")("off");
  const here = [first];
  if (hostOn) here.push(cfg.url !== "" ? c("muted")(cfg.url!) : c("warn")("no link yet, e to enter one"));
  if (m) {
    const dl = obj(m.download);
    if (dl && truthy(dl.total)) here.push(bar(num(dl.done) / num(dl.total), "") + "  " + c("muted")(gb(num(dl.done)) + " of " + gb(num(dl.total))));
    if (!truthy(m.ready) && str(m.why) !== "") here.push(c("warn")(str(m.why)));
  }
  const picked = ui.sel[modelTab]! < all.length ? all[ui.sel[modelTab]!] : undefined;
  // read-only: the frontend's Agents page assigns
  const rl: string[] = [];
  for (const a of objs(model.agents)) {
    const x = obj(get(a, "slots", "model")) ?? {};
    const s = str(x.model);
    const name = s !== "" ? s : c("dim")("none");
    let why = "";
    if (!truthy(x.ready) && str(x.why) !== "") why = "  " + c("warn")(str(x.why));
    rl.push(c("accent")(str(a.id).padEnd(12)) + name + why);
  }
  rl.push(c("dim")("assigned in the frontend's Agents page"));
  let models = plainRows(c("muted")("no host runs a model"));
  if (all.length > 0) {
    models = table(["host", "agents", "state", "speed", "file"], rows, ui.sel[modelTab]!, 0);
    if (picked && mi !== ui.sel[modelTab] && !truthy(picked.ready) && str(picked.why) !== "") models.push({ text: c("warn")(str(picked.why)) });
  }
  return {
    lines: panels({ title: "agents", lines: plainRows(...rl) }, { title: "this host", lines: plainRows(...here) }, { title: "models", lines: models }),
    keys: [k("e edit", "primary")],
  };
}

// the chain this host can see
export function liveChain(st: J | undefined): [J | undefined, boolean] {
  const ch = obj(st?.chain);
  if (ch && !truthy(ch.done)) return [ch, truthy(st?.chainMine)];
  return [undefined, false];
}

// block cells in brackets, as the files transfer bar, narrower on a narrow terminal
export function bar(frac: number, tok: string): string {
  let n = inner() - 40;
  if (n > 30) n = 30;
  if (n < 10) n = 10;
  let full = Math.round(frac * n);
  if (full > n) full = n;
  if (!(full >= 0)) full = 0;
  const p = c(or(tok, "accent"));
  return p("[" + "█".repeat(full)) + fg(off) + "░".repeat(n - full) + p("]");
}

// a running host's stage, every peer updating at once, and how far along it is
const stageLabel: Record<string, string> = { asked: "starting", installing: "installing", restarting: "restarting" };
const stageDone: Record<string, number> = { asked: 0.15, installing: 0.45, restarting: 0.8 };

const stageOf = (chain: J | undefined, host: string) => str(get(chain, "versions", host, "stage"));

// the mesh's progress, each host weighed by its stage, so the bar moves as
// the hosts do, not in one jump per host
function progress(chain: J): string {
  const order = strs(chain.order);
  const res = obj(chain.results) ?? {};
  let done = 0, finished = 0;
  for (const m of order) {
    switch (or(str(res[m]), "pending")) {
      case "running":
        done += stageDone[stageOf(chain, m)] ?? 0.05;
        break;
      case "pending":
        break;
      default:
        done++;
        finished++;
    }
  }
  return bar(done / order.length, "") + "  " + c("muted")(`${finished}/${order.length} hosts`);
}

const stepLabel: Record<string, string> = {
  pending: "waiting", running: "updating", ok: "success", current: "up to date",
  fail: "failed", unreachable: "unreachable", skipped: "skipped",
};

function updateView(): View {
  const st = ui.state!;
  const self = selfHost();
  const [chain, mine] = liveChain(st);
  let last: J | undefined;
  const ch = obj(st.chain);
  if (ch && truthy(ch.done)) last = ch;
  const shownCh = chain ?? last;
  let title = "mesh update";
  if (!chain && last) title = "mesh update finished";
  else if (chain) title = "updating the mesh";
  const tail = objs(st.tailnet);
  const byName: Record<string, J> = {};
  // one that answered before listed too, as not answering
  const names: string[] = [];
  for (const d of tail) {
    byName[str(d.name)] = d;
    if (truthy(d.phosphorus) || truthy(d.phosphorusSeen)) names.push(str(d.name));
  }
  if (indexOf(names, self) < 0) names.push(self);
  const quiet = (m: string) => {
    const d = byName[m];
    return m !== self && d !== undefined && truthy(d.phosphorusSeen) && !truthy(d.phosphorus);
  };
  let order: string[];
  if (shownCh) {
    order = strs(shownCh.order);
    for (const n of names) if (indexOf(order, n) < 0) order.push(n);
  } else order = [...names].sort();
  const selfVer = str(get(st, "self", "version"));
  const rows: string[][] = [];
  const why: string[] = [];
  for (const m of order) {
    const d = byName[m] ?? {};
    const isSelf = m === self;
    let version = str(d.version), osName = str(d.os);
    if (isSelf) {
      version = selfVer;
      osName = str(get(st, "self", "platform"));
    }
    const step = shownCh ? str(get(shownCh, "results", m)) : "";
    const os = c("teal")(osName);
    let paint = (s: string) => s;
    switch (step) {
      case "pending":
      case "skipped":
        paint = c("muted");
        break;
      case "running":
        paint = c("accent");
        break;
      case "fail":
      case "unreachable":
        paint = c("offmesh");
    }
    let bare = m;
    if (step === "skipped") bare = strike(m);
    if (step !== "fail" && step !== "unreachable") bare = paint(bare);
    let name = bare;
    if (isSelf) name = c("accent")("■") + " " + bare;
    const ver = version !== "" ? "v" + version : "?";
    let verText = ver;
    if (step !== "") verText = c("muted")(ver);
    else if (!shownCh && version !== selfVer) verText = c("warn")(ver);
    let label = or(stepLabel[step] ?? "", step);
    if (step === "running" && stageLabel[stageOf(shownCh, m)]) label = stageLabel[stageOf(shownCh, m)]!;
    if (step === "fail" || step === "unreachable") {
      label = or(str(get(shownCh, "errors", m)), label);
      const det = str(get(shownCh, "details", m));
      if (det !== "") why.push(c("sky")(m) + " " + c("muted")(det));
    }
    if (step === "" && quiet(m)) {
      rows.push([name + " " + os, c("muted")(ver), c("offmesh")("not answering")]);
      continue;
    }
    let state = paint(label);
    if (step === "ok" || step === "current") state = c("online")(label);
    rows.push([name + " " + os, verText, state]);
  }
  let prog: Card | undefined;
  if (chain) {
    const ls = [progress(chain)];
    if (!mine) ls.push(c("muted")("started by " + str(chain.initiator)));
    prog = { title: "progress", lines: plainRows(...ls) };
  }
  let keys: Key[] = [k("enter update", "primary")];
  if (chain) keys = mine ? [k("x cancel", "danger")] : [];
  let failed: Card | undefined;
  if (why.length > 0) failed = { title: "why", lines: plainRows(...why) };
  return { lines: panels(prog, { title, lines: table(["host", "version", ""], rows, -1, 0) }, failed), keys, title: "mesh update" };
}

function offlineView(): string[] {
  return panels({
    title: "offline",
    lines: plainRows(
      c("offmesh")(`the frontend is not answering on :${FrontendPort}`), "",
      c("muted")("phosphorus is down or restarting, start it with"), "", "  " + c("accent")("phos start"), "",
      c("muted")("this screen clears on its own once it answers"),
    ),
  });
}

// every service by name, the edited one on the accent, widened out from it
// until the screen is full, … marking what's cut
function serviceStrip(f: Form): string {
  const names = splitSections(readText(servicesFile)).secs.map((s) => s.name);
  let cur = f.orig;
  if (f.isNew) {
    names.push("+ new");
    cur = "+ new";
  }
  let at = indexOf(names, cur);
  if (at < 0) at = 0;
  if (names.length === 0) return "";
  const room = inner() - 4;
  const cell = (n: string) => vlen(n) + 3;
  let lo = at, hi = at, used = cell(names[at]!);
  for (let grew = true; grew; ) {
    grew = false;
    if (hi + 1 < names.length && used + cell(names[hi + 1]!) <= room) {
      hi++;
      used += cell(names[hi]!);
      grew = true;
    }
    if (lo > 0 && used + cell(names[lo - 1]!) <= room) {
      lo--;
      used += cell(names[lo]!);
      grew = true;
    }
  }
  const cells: string[] = [];
  for (let i = lo; i <= hi; i++) {
    if (i === at) cells.push(bold(surface(pal.accent!, pal.bg!)(" " + names[i] + " ")));
    else cells.push(c("muted")(" " + names[i] + " "));
  }
  let out = cells.join(" ");
  if (lo > 0) out = c("muted")("… ") + out;
  if (hi < names.length - 1) out += c("muted")(" …");
  return out;
}

// .update-pass: the value on the card surface, the accent marking focus
function formView(f: Form): View {
  let w = 0, widest = 0;
  for (const x of f.fields) {
    if (x.key.length > w) w = x.key.length;
    if (vlen(x.value) + 1 > widest) widest = vlen(x.value) + 1;
    if (x.secret && widest < 24) widest = 24;
  }
  const hint = (x: Field) => (x.choices ? x.hint + "  space cycles" : x.hint);
  // values clipped to leave the hints a column of 24 where there's room
  let vw = inner() - 7 - w - 24;
  if (widest < vw) vw = widest;
  if (vw < 12) vw = 12;
  const left = 7 + w + vw;
  const beside = inner() - left >= 36;
  const fields: string[] = [];
  f.fields.forEach((x, i) => {
    const on = i === f.idx;
    let shownV = x.value;
    if (x.secret) shownV = "•".repeat(Math.min([...x.value].length, vw - 2));
    const chars = [...shownV];
    if (chars.length >= vw) shownV = on ? "…" + chars.slice(chars.length - vw + 2).join("") : chars.slice(0, vw - 1).join("") + "…";
    let value: string;
    if (on) value = surface(pal.card!)(" " + pad(shownV + caret() + bg(pal.card!), vw) + " ");
    else {
      if (shownV === "") shownV = c("dim")("-");
      value = " " + pad(shownV, vw) + " ";
    }
    const mark = on ? c("accent")("›") : " ";
    const head = mark + " " + c("accent2")(pad(x.key, w)) + " " + value;
    if (!beside) {
      fields.push(head);
      for (const l of wrap(c("muted")(hint(x)), inner() - 4, 0)) fields.push("    " + l);
      return;
    }
    const hs = wrap(c("muted")(hint(x)), inner() - left, 0);
    fields.push(head + "  " + hs[0]);
    for (const l of hs.slice(1)) fields.push(" ".repeat(left) + l);
  });
  const notes: string[] = [];
  if (f.kind === "share") notes.push(c("muted")(iniNote));
  if (f.kind === "model") notes.push(c("muted")(modelNote));
  if (f.kind === "keys") {
    notes.push(c("muted")(keysNote));
    if (f.first) notes.push(c("muted")(joinNote));
    else if (!ui.keysOnly) notes.push(c("muted")(keysNoteApply));
  }
  if (f.err !== "") notes.push(c("offmesh")(f.err));
  let strip: Card | undefined, notesCard: Card | undefined;
  if (f.kind === "service") strip = { title: "services", lines: plainRows(serviceStrip(f)) };
  if (notes.length > 0) notesCard = { title: "notes", lines: plainRows(...notes) };
  return {
    title: f.title,
    lines: panels(strip, { title: f.title, lines: plainRows(...fields) }, notesCard),
    keys: [k("enter save", "primary"), k("esc cancel"), k("↑↓ field", "quiet"), kif(strip !== undefined, "←→ service", "quiet")],
  };
}

export function currentView(): View {
  if (ui.form && (ui.keysOnly || ui.offline)) return formView(ui.form);
  if (ui.offline || !ui.state) {
    if (ui.offline) return { lines: offlineView(), keys: [] };
    return { lines: [c("muted")(" reaching the frontend...")], keys: [] };
  }
  if (ui.form) return formView(ui.form);
  return [statsView, servicesView, filesView, modelView, gitView, updateView][ui.tab]!();
}

