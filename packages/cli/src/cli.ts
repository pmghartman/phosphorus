// the terminal ui, run by the host's phosphorus on the service's env, reading
// this host's /api/state and writing straight to config/
import { missing } from "@phosphorus/envfile";
import { env, errText, FrontendPort, marshal, sleep } from "@phosphorus/util";
import { deleteService, modelForm, readGitHost, readText, readShares, serviceForm, servicesFile, shareForm, splitSections, switchService, saveModel, saveService, saveShare, writeGitHost, writeHomeDir, isHomeDir, writeShares, type Share } from "./config.ts";
import { base, bg, c, caret, fit, max0, pal, selMark, setTheme, size, surface, wrap } from "./draw.ts";
import type { Form } from "./form.ts";
import { type KeyEv, Parser } from "./input.ts";
import { type J, get, indexOf, num, obj, objs, or, str, truthy } from "./json.ts";
import { applyKeys, keysForm, keysSaved, saveKeys, setEnvFile } from "./keys.ts";
import { filesTab, gitTab, iniNote, modelTab, openForm, rebuilding, servicesTab, shown, statsTab, tabs, ui, updateTab } from "./state.ts";
import { quitSignals, sigResize } from "./sys.ts";
import { currentView, hints, k, liveChain, topBar } from "./views.ts";

const api = `http://127.0.0.1:${FrontendPort}`;
const out = process.stdout;

// --- the api ----------------------------------------------------------------------

type Reply = { status: number; body: J };

// one call with a 2s cap, never proxied: status 0 with the error when it failed
async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(api + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? marshal(body) : undefined,
      signal: AbortSignal.timeout(2000),
      proxy: false,
    } as RequestInit);
  } catch (e) {
    return { status: 0, body: { error: errText(e) } };
  }
  let o: J = {};
  try {
    o = obj(JSON.parse(await res.text())) ?? {};
  } catch {}
  return { status: res.status, body: o };
}

const post = (path: string, body?: unknown) => call("POST", path, body);

function chainPost(action: string, password?: string) {
  const b: J = { action };
  if (password !== undefined) b.password = password;
  return post("/api/update/chain", b);
}

// --- ui state -----------------------------------------------------------------------

// everything touching ui runs on the loop; after it ended, nothing does
let alive = false;
let finish: ((code: number) => void) | undefined;
let fail: ((e: unknown) => void) | undefined;

function onLoop(f: () => void) {
  if (!alive) return;
  try {
    f();
  } catch (e) {
    fail?.(e);
  }
}

function flash(msg: string) {
  ui.flash = msg;
  ui.flashAt = Date.now();
  render();
}

// a request asked of the poller, one in flight at a time, a poll asked for
// mid-flight run right after
let poked = false;
let pokeWake: (() => void) | undefined;

function poll() {
  if (pokeWake) {
    const w = pokeWake;
    pokeWake = undefined;
    w();
  } else poked = true;
}

async function poller() {
  while (alive) {
    const every = await pollOnce();
    if (!alive) return;
    if (poked) {
      poked = false;
      continue;
    }
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        pokeWake = undefined;
        r();
      }, every);
      pokeWake = () => {
        clearTimeout(t);
        r();
      };
    });
  }
}

async function pollOnce(): Promise<number> {
  const tab = ui.tab;
  const r = await call("GET", "/api/state");
  if (r.status !== 200) {
    onLoop(() => {
      ui.offline = true;
      render();
    });
    return 500;
  }
  const st = r.body;
  if (Date.now() - pingedAt >= 2000) {
    pingedAt = Date.now();
    void pingHosts(st);
  }
  let info: J | undefined;
  if (tab === filesTab) {
    const host = str(get(st, "self", "host"));
    info = obj(get(st, "hosts", host.toLowerCase(), "files"));
    if (!info) {
      const x = await call("GET", "/api/files/" + host + "/info");
      if (x.status !== 0) info = x.body;
    }
  }
  onLoop(() => {
    ui.state = st;
    ui.offline = false;
    if (tab === filesTab) ui.filesInfo = info;
    render();
  });
  const ms = num(st.pollMs);
  return ms > 0 ? ms : 500;
}

// the poller's alone, pings every 2s at most
let pingedAt = 0;

// pingHosts every host timed from this terminal, as the page times its own,
// null for one that didn't answer
async function pingHosts(st: J) {
  const hosts = [str(get(st, "self", "host"))];
  for (const d of objs(st.tailnet)) if (truthy(d.phosphorus) && str(d.name) !== hosts[0]) hosts.push(str(d.name));
  const got: Record<string, unknown> = {};
  await Promise.all(
    hosts.map(async (h) => {
      const t = Date.now();
      const r = await call("GET", "/api/ping/" + encodeURIComponent(h));
      got[h] = r.status === 204 ? Date.now() - t : null;
    }),
  );
  onLoop(() => {
    ui.rtt = got;
    render();
  });
}

// --- render ---------------------------------------------------------------------------

// selAt the last frame's selected body line, -1 for none
let selAt = -1;

// glow the header line alone redrawn, its wordmark's bands slid on
function glow() {
  const [cols] = size();
  out.write("\x1b[H" + base + fit(topBar(cols), cols) + "\x1b[K");
}

function render() {
  const [cols, rows] = size();
  let global: ReturnType<typeof k>[] = [];
  if (!ui.form && !ui.keysOnly) {
    global = [k("u update", "quiet"), k("k keys", "quiet"), k("q quit", "quiet")];
    if (ui.tab === updateTab) global = [k("esc back", "quiet"), k("q quit", "quiet")];
  }
  let status = "";
  let hint: ReturnType<typeof k>[] | undefined;
  if (ui.prompt) {
    const p = ui.prompt;
    let label = c("muted")(p.label);
    if (p.err !== "") label = c("offmesh")(p.err);
    status = " " + label + " " + surface(pal.card!)(" " + "•".repeat([...p.value].length) + caret() + bg(pal.card!) + " ");
    hint = [k("enter send", "primary"), k("esc cancel")];
  } else if (ui.confirm) {
    status = " " + ui.confirm.text;
    hint = [k("y yes", ui.confirm.danger ? "danger" : "primary"), k("n no")];
  } else if (ui.flash !== "" && Date.now() - ui.flashAt < 8000) status = " " + ui.flash;
  // a view drawn again if the footer's rows moved its room
  let v = currentView();
  const footer = () => {
    const f = status !== "" ? wrap(status, cols, 1) : [];
    f.push(hint ? hints(hint, [], cols) : hints(v.keys, global, cols));
    // a blank row under the bar, so a window's edge never cuts it
    f.push("");
    return f;
  };
  let foot = footer();
  const head = [topBar(cols), ""];
  let room = rows - head.length - foot.length - 1;
  if (room < 1) room = 1;
  if (room !== ui.room) {
    ui.room = room;
    v = currentView();
    foot = footer();
  }
  let body = v.lines.map((l) => " " + l);
  // past the room: scrolled, the selected row kept in view, an arrow where more is
  let at = -1;
  body = body.map((l, i) => {
    if (!l.includes(selMark)) return l;
    if (at < 0) at = i;
    return l.replace(selMark, "");
  });
  if (body.length > room) {
    // followed only when it moved, pgup and pgdn free to look past it
    if (at >= 0 && at !== selAt && room > 2) {
      ui.scroll = Math.min(ui.scroll, at - 1);
      ui.scroll = Math.max(ui.scroll, at - room + 2);
    }
    ui.scroll = max0(Math.min(ui.scroll, body.length - room));
    const more = body.length - ui.scroll - room;
    body = body.slice(ui.scroll, ui.scroll + room);
    if (ui.scroll > 0 && room > 1) body[0] = " " + c("muted")("↑ more, pgup");
    if (more > 0 && room > 1) body[room - 1] = " " + c("muted")(`↓ ${more + 1} more, pgdn`);
  } else ui.scroll = 0;
  selAt = at;
  const lines = [...head, ...body];
  while (lines.length < rows - foot.length) lines.push("");
  lines.push(...foot);
  if (lines.length > rows) lines.length = rows;
  let b = "\x1b[H";
  lines.forEach((l, i) => {
    if (i > 0) b += "\x1b[K\r\n";
    b += base + fit(l, cols);
  });
  out.write(b + "\x1b[K\x1b[J");
}

// --- keys ---------------------------------------------------------------------------

const savers: Record<string, (f: Form) => string> = { service: saveService, share: saveShare, model: saveModel, keys: saveKeys };

function formKey(s: string, e: KeyEv) {
  const f = ui.form!;
  if (e.name === "escape") {
    ui.form = undefined;
    if (ui.keysOnly) quit(1);
    return;
  }
  if (f.kind === "service" && (e.name === "left" || e.name === "right")) {
    switchService(e.name === "right" ? 1 : -1);
    return;
  }
  if (e.name === "return") {
    f.err = savers[f.kind]!(f);
    if (f.err !== "") return;
    ui.form = undefined;
    if (f.kind === "service") {
      const name = f.fields[0]!.value.trim();
      const i = splitSections(readText(servicesFile)).secs.findIndex((x) => x.name === name);
      if (i >= 0) ui.sel[servicesTab] = i;
    }
    if (f.kind === "keys") {
      if (ui.keysOnly) quit(0);
      else {
        flash(c("online")(keysSaved));
        applyKeys();
      }
      return;
    }
    // only a share, or [model] host or gpu, changing what phosphorus was started with
    let rebuilds = f.kind === "share";
    for (const x of f.fields) {
      if (f.kind === "model" && ((x.key === "gpu" && x.value.trim() !== f.gpuWas) || (x.key === "host" && x.value.trim() !== f.hostWas))) rebuilds = true;
    }
    if (ui.offline) flash(c("online")("saved, applied once phosphorus is up: phos start"));
    else if (rebuilds) flash(c("online")("saved, " + rebuilding));
    else flash(c("online")("saved, live on the next tick"));
    poll();
    return;
  }
  fieldKey(f, s, e);
}

// moving between fields, cycling choices and typing, any form
function fieldKey(f: Form, s: string, e: KeyEv) {
  const x = f.fields[f.idx]!;
  const n = f.fields.length;
  if (e.name === "up" || (e.name === "tab" && e.shift)) {
    f.idx = (f.idx + n - 1) % n;
    return;
  }
  if (e.name === "down" || e.name === "tab") {
    f.idx = (f.idx + 1) % n;
    return;
  }
  // space cycling choices, never typed into a field that has them
  if (s === " " && x.choices) {
    x.value = x.choices[(indexOf(x.choices, x.value) + 1) % x.choices.length]!;
    return;
  }
  // the model's choices cycled, or picked by their first letter
  if (x.choices && f.kind === "model") {
    for (const ch of x.choices) {
      if (s !== "" && ch.startsWith(s.toLowerCase())) {
        x.value = ch;
        break;
      }
    }
    return;
  }
  if (e.name === "backspace") {
    const r = [...x.value];
    if (r.length > 0) x.value = r.slice(0, -1).join("");
    return;
  }
  if (s !== "" && !e.ctrl && !e.meta && s >= " " && s !== "\x7f") x.value += s;
}

function modelKey(s: string, e: KeyEv) {
  const all = objs(get(ui.state, "model", "models"));
  if (e.name === "up") ui.sel[modelTab] = max0(ui.sel[modelTab]! - 1);
  else if (e.name === "down") ui.sel[modelTab] = max0(Math.min(all.length - 1, ui.sel[modelTab]! + 1));
  else if (s === "e" || e.name === "return") openForm(modelForm());
}

const crlfRe = /[\r\n]+/g;
const linkRe = /^https?:\/\//;

// a paste whole: a link on the model tab opening [model] with it as url,
// anything else where typing goes
function onPaste(text: string) {
  const clean = text.replace(crlfRe, "");
  if (ui.prompt) {
    ui.prompt.value += clean;
    return;
  }
  const link = linkRe.test(clean.trim());
  if (!ui.form && ui.tab === modelTab && link && !ui.offline && ui.state && !ui.confirm) openForm(modelForm());
  const f = ui.form;
  if (!f) return;
  if (f.kind === "model" && link) {
    const i = f.fields.findIndex((x) => x.key === "url");
    if (i >= 0) {
      f.idx = i;
      f.fields[i]!.value = clean.trim();
      return;
    }
  }
  const x = f.fields[f.idx]!;
  if (!x.choices) x.value += clean;
}

function listKey(s: string, e: KeyEv) {
  switch (ui.tab) {
    case servicesTab: {
      const secs = splitSections(readText(servicesFile)).secs;
      const sec = ui.sel[servicesTab]! < secs.length ? secs[ui.sel[servicesTab]!] : undefined;
      if (e.name === "up") ui.sel[servicesTab] = max0(ui.sel[servicesTab]! - 1);
      else if (e.name === "down") ui.sel[servicesTab] = max0(Math.min(secs.length - 1, ui.sel[servicesTab]! + 1));
      else if (s === "a") openForm(serviceForm(undefined));
      else if ((s === "e" || e.name === "return") && sec) openForm(serviceForm(sec));
      else if (s === "d" && sec) {
        const name = sec.name;
        ui.confirm = {
          text: "delete [" + name + "]?",
          danger: true,
          onYes: () => {
            const err = deleteService(name);
            if (err !== "") flash(c("offmesh")(err));
            else flash(c("online")("[" + name + "] deleted"));
            poll();
          },
        };
      }
      break;
    }
    case filesTab: {
      const shares = readShares();
      const i = ui.sel[filesTab]!;
      const has = i < shares.length;
      if (e.name === "up") ui.sel[filesTab] = max0(i - 1);
      else if (e.name === "down") ui.sel[filesTab] = max0(Math.min(shares.length - 1, i + 1));
      else if (s === "a") openForm(shareForm(-1));
      else if (s === "h" && has) {
        const dir = shares[i]!.dir;
        const isOff = isHomeDir(dir);
        const what = isOff ? "home/ back to the default files/" : "home/ into " + dir;
        ui.confirm = {
          text: what + "? it moves with everything in it, " + iniNote,
          onYes: () => {
            const err = writeHomeDir(isOff ? "" : dir);
            if (err !== "") flash(c("offmesh")(err));
            else flash(c("online")("saved, " + rebuilding));
            poll();
          },
        };
      } else if ((s === "e" || e.name === "return") && has) openForm(shareForm(i));
      else if (s === "d" && has) {
        ui.confirm = {
          text: "stop publishing " + shares[i]!.dir + "? " + iniNote,
          danger: true,
          onYes: () => {
            const kept: Share[] = [...shares.slice(0, i), ...shares.slice(i + 1)];
            let err = writeShares(kept);
            // the home's own dir dropped: home back to the default
            if (err === "" && isHomeDir(shares[i]!.dir)) err = writeHomeDir("");
            if (err !== "") flash(c("offmesh")(err));
            else flash(c("online")("removed, " + rebuilding));
          },
        };
      }
      break;
    }
    case gitTab:
      gitKey(s, e);
      break;
    case statsTab:
      if (e.name === "up") ui.scroll = max0(ui.scroll - 1);
      else if (e.name === "down") ui.scroll++;
      break;
    case modelTab:
      modelKey(s, e);
  }
}

// --- git: the flag in phosphorus.ini, and the git card's make master ---------------

function gitKey(s: string, e: KeyEv) {
  const hosts = objs(ui.state?.gitHosts);
  if (e.name === "up") ui.sel[gitTab] = max0(ui.sel[gitTab]! - 1);
  else if (e.name === "down") ui.sel[gitTab] = max0(Math.min(hosts.length - 1, ui.sel[gitTab]! + 1));
  else if (s === "h" && !readGitHost() && process.platform !== "linux") flash(c("offmesh")(writeGitHost(true)));
  else if (s === "h") {
    const on = !readGitHost();
    const text = on ? "make this host a git host (forgejo)? " + iniNote : "stop being a git host? phosphorus-git is removed, " + iniNote;
    ui.confirm = {
      text,
      danger: !on,
      onYes: () => {
        const err = writeGitHost(on);
        if (err !== "") flash(c("offmesh")(err));
        else if (on) flash(c("online")("git host on; " + rebuilding));
        else flash(c("online")("git host off; " + rebuilding));
      },
    };
  } else if (s === "p" && ui.sel[gitTab]! < hosts.length) askGitSwitch(hosts[ui.sel[gitTab]!]!);
}

// the card's dialog: a live master handing off, none force-promoting
function askGitSwitch(target: J) {
  if (!truthy(target.reachable) || str(target.role) === "master") return;
  const master = objs(ui.state?.gitHosts).find((h) => str(h.role) === "master" && truthy(h.reachable));
  const name = str(target.host);
  const text = master ? name + " master?" : "force " + name + "?";
  ui.confirm = {
    text,
    danger: !master,
    onYes: () => {
      void (async () => {
        const r = await post("/api/githosts/" + encodeURIComponent(name) + "/force");
        onLoop(() => {
          if (r.status === 200) flash(c("online")("switching"));
          else flash(c("offmesh")("make master failed: " + or(str(r.body.error), `status ${r.status}`)));
          poll();
        });
      })();
    },
  };
}

// --- the mesh update: a thin client over /api/update/chain -----------------------

function askStart() {
  const lock = obj(get(ui.state, "lock"));
  if (lock) {
    flash(c("warn")("already updating, started by " + str(lock.initiator)));
    return;
  }
  ui.confirm = { text: "network down for a while. continue?", onYes: () => askPassword("") };
}

function askPassword(err: string) {
  ui.prompt = { label: "admin password", value: "", err, onSubmit: (pw) => void startChain(pw) };
  render();
}

async function startChain(password: string) {
  const r = await chainPost("start", password);
  onLoop(() => {
    if (r.status === 401) askPassword("wrong password");
    else if (r.status === 409) flash(c("warn")("already updating, started by " + or(str(r.body.by), "another host")));
    else if (r.status !== 202) flash(c("offmesh")(or(str(r.body.error), `update didn't start (status ${r.status})`)));
    poll();
  });
}

function updateKey(s: string) {
  const [, mine] = liveChain(ui.state);
  if (s === "x" && mine) {
    ui.confirm = {
      danger: true,
      text: "cancel the mesh update? hosts already updating still finish",
      onYes: () => {
        void chainPost("cancel").then(() => poll());
      },
    };
  }
}

function onKey(e: KeyEv) {
  const s = e.str;
  if (e.ctrl && e.name === "c") {
    quit(0);
    return;
  }
  if (e.name === "paste") {
    onPaste(s);
    render();
    return;
  }
  if (ui.prompt) {
    const p = ui.prompt;
    if (e.name === "escape") ui.prompt = undefined;
    else if (e.name === "return") {
      ui.prompt = undefined;
      p.onSubmit(p.value);
    } else if (e.name === "backspace") {
      const r = [...p.value];
      if (r.length > 0) p.value = r.slice(0, -1).join("");
    } else if (s !== "" && !e.ctrl && s >= " ") p.value += s;
  } else if (ui.confirm) {
    const cf = ui.confirm;
    ui.confirm = undefined;
    if (s === "y" || s === "Y") cf.onYes();
  } else if (e.name === "pageup") ui.scroll = max0(ui.scroll - Math.max(1, ui.room - 2));
  else if (e.name === "pagedown") ui.scroll += Math.max(1, ui.room - 2);
  else if (ui.form) {
    // every form writes files here alone, kept working with the frontend down
    formKey(s, e);
  } else if (s === "q") {
    quit(0);
    return;
  } else if (s === "k") openForm(keysForm(false));
  else if (s === "u" && ui.tab !== updateTab) {
    ui.back = ui.tab;
    switchTab(updateTab);
  } else if (ui.tab === updateTab && (e.name === "escape" || s === "u")) switchTab(ui.back);
  else if (ui.tab === updateTab && (e.name === "return" || s === "U")) {
    const [ch] = liveChain(ui.state);
    if (ui.state && !ch) askStart();
  } else if (ui.tab === updateTab && (s === "c" || s === "x")) updateKey(s);
  else if (s.length === 1 && s >= "1" && s <= "9" && Number(s) <= shown) switchTab(Number(s) - 1);
  else if (e.name === "tab" || e.name === "right" || e.name === "left") {
    const step = e.shift || e.name === "left" ? shown - 1 : 1;
    const from = ui.tab === updateTab ? ui.back : ui.tab;
    switchTab((from + step) % shown);
  } else if (!ui.offline && ui.state) listKey(s, e);
  render();
}

function switchTab(i: number) {
  ui.tab = i;
  ui.scroll = 0;
  if (i === filesTab) poll();
}

// --- startup ------------------------------------------------------------------------

let quitting = false;

function quit(code: number) {
  if (quitting) return;
  quitting = true;
  finish?.(code);
}

// main runs the ui: update-all opens on the start prompt, --tab keeps a reconnect's place
export function main(args: string[]): Promise<number> {
  args.forEach((a, i) => {
    if (a === "--tab" && i + 1 < args.length) ui.tab = max0(indexOf(tabs, args[i + 1]!.toLowerCase()));
  });
  const updateAll = args.length > 0 && args[0] === "update-all";
  if (updateAll) ui.tab = updateTab;
  let later: (() => Promise<void>) | undefined;
  if (updateAll) {
    // the start prompt once the first poll says whether a chain already runs
    later = async () => {
      while (alive && !(ui.state || ui.offline)) await sleep(50);
      onLoop(() => {
        if (!ui.offline) {
          askStart();
          render();
        }
      });
    };
  }
  return run(later, undefined);
}

// keys the key form alone, before phosphorus runs: 0 saved, 1 cancelled
export function keys(file: string): Promise<number> {
  setEnvFile(file);
  ui.keysOnly = true;
  return run(undefined, () => openForm(keysForm(missing(file).length > 0)));
}

// stdin's chunks queued until the loop takes them, null once it closed
const chunks: (string | null)[] = [];
let chunkWake: (() => void) | undefined;
let sink: ((s: string | null) => void) | undefined;

function deliver(s: string | null) {
  if (sink) sink(s);
  else {
    chunks.push(s);
    chunkWake?.();
  }
}

// a chunk, or ms gone by
const waitChunk = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(() => {
      chunkWake = undefined;
      r();
    }, ms);
    chunkWake = () => {
      clearTimeout(t);
      chunkWake = undefined;
      r();
    };
  });

// run the terminal loop: later off the loop, first on it before the first frame,
// polling the frontend unless only the keys are asked for
async function run(later?: () => Promise<void>, first?: () => void): Promise<number> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    process.stderr.write("phosphorus needs a terminal; run it as plain `phosphorus`\n");
    return 2;
  }
  try {
    stdin.setRawMode(true);
  } catch (e) {
    process.stderr.write(errText(e) + "\n");
    return 1;
  }
  const done = new Promise<number>((res, rej) => {
    finish = res;
    fail = rej;
  });
  alive = true;
  const dec = new TextDecoder();
  const onData = (b: Uint8Array) => deliver(dec.decode(b, { stream: true }));
  const onEnd = () => deliver(null);
  const onResize = () => onLoop(render);
  const onSignal = () => quit(0);
  let tick: ReturnType<typeof setInterval> | undefined, shine: ReturnType<typeof setInterval> | undefined;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    alive = false;
    out.write("\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l");
    try {
      stdin.setRawMode(false);
    } catch {}
    stdin.off("data", onData);
    stdin.off("end", onEnd);
    stdin.pause();
    if (sigResize) process.off(sigResize, onResize);
    for (const sig of quitSignals) process.off(sig, onSignal);
    clearInterval(tick);
    clearInterval(shine);
    // the poller woken to find the loop gone
    pokeWake?.();
  };
  try {
    out.write("\x1b[?1049h\x1b[?25l\x1b[?2004h");
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.resume();
    const rest = await pickTheme();

    if (sigResize) process.on(sigResize, onResize);
    for (const sig of quitSignals) process.on(sig, onSignal);
    if (!ui.keysOnly) void poller();
    if (later) void later();
    if (first) first();
    render();

    const p = new Parser();
    const feed = (s: string) => {
      for (const e of p.feed(s)) onKey(e);
    };
    sink = (s) => {
      if (s === null) {
        quit(0);
        return;
      }
      onLoop(() => feed(s));
    };
    for (const s of chunks.splice(0)) sink(s);
    onLoop(() => feed(rest));
    shine = setInterval(() => onLoop(glow), 100);
    let [cols, rows] = size();
    let minute = new Date().getMinutes();
    tick = setInterval(
      () =>
        onLoop(() => {
          // the flash line cleared once stale, a resize caught where no signal tells
          const [cc, rr] = size();
          const m = new Date().getMinutes();
          if (m !== minute) {
            minute = m;
            render();
          }
          const since = Date.now() - ui.flashAt;
          if (cc !== cols || rr !== rows || (ui.flash !== "" && since >= 8000 && since < 10000)) {
            cols = cc;
            rows = rr;
            render();
          }
        }),
      1000,
    );
    const code = await done;
    restore();
    return code;
  } catch (e) {
    restore();
    throw e;
  } finally {
    sink = undefined;
  }
}

// OSC 11: the terminal's own background, answered nearly everywhere, then DA1,
// answered everywhere, its reply the end of the wait; what came after it handed back
const da1Re = /\x1b\[\?[\d;]*c/;
const osc11Re = /\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(\x1b\\|\x07)?/i;

async function pickTheme(): Promise<string> {
  out.write("\x1b]11;?\x1b\\\x1b[c");
  let got = "";
  const deadline = Date.now() + 600;
  while (!da1Re.test(got)) {
    if (chunks.length > 0) {
      // closed: left for the loop to see
      if (chunks[0] === null) break;
      got += chunks.shift();
      continue;
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await waitChunk(left);
  }
  let light: boolean;
  const m = osc11Re.exec(got);
  if (m) {
    const v = [1, 2, 3].map((i) => parseInt(m[i]!, 16) / (16 ** m[i]!.length - 1));
    light = 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]! > 0.5;
  } else {
    const parts = env("COLORFGBG").split(";");
    const bgv = parts[parts.length - 1];
    light = bgv === "7" || bgv === "15";
  }
  setTheme(light);
  got = got.replace(new RegExp(osc11Re.source, "gi"), "");
  return got.replace(new RegExp(da1Re.source, "g"), "");
}
