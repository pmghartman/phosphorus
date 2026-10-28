// keys
import {
  isHomeDir,
  readGitHost,
  readShares,
  readText,
  type Share,
  servicesFile,
  splitSections,
  writeGitHost,
  writeHomeDir,
  writeShares,
} from "@phosphorus/config";
import { chainPost, post } from "./api.ts";
import { quit } from "./cli.ts";
import { c, max0 } from "./draw.ts";
import type { Form } from "./form.ts";
import {
  deleteService,
  modelForm,
  saveModel,
  saveService,
  saveShare,
  serviceForm,
  shareForm,
  switchService,
} from "./forms.ts";
import { type KeyEv } from "./input.ts";
import { get, indexOf, type J, obj, objs, or, str, truthy } from "./json.ts";
import { applyKeys, keysForm, keysSaved, saveKeys } from "./keys.ts";
import { flash, onLoop, poll } from "./loop.ts";
import { render } from "./render.ts";
import {
  filesTab,
  gitTab,
  iniNote,
  modelTab,
  openForm,
  rebuilding,
  servicesTab,
  shown,
  statsTab,
  ui,
  updateTab,
} from "./state.ts";
import { liveChain } from "./views.ts";

export const savers: Record<string, (f: Form) => string> = {
  service: saveService,
  share: saveShare,
  model: saveModel,
  keys: saveKeys,
};

export function formKey(s: string, e: KeyEv) {
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
      if (
        f.kind === "model" &&
        ((x.key === "gpu" && x.value.trim() !== f.gpuWas) || (x.key === "host" && x.value.trim() !== f.hostWas))
      )
        rebuilds = true;
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
export function fieldKey(f: Form, s: string, e: KeyEv) {
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

export function modelKey(s: string, e: KeyEv) {
  const all = objs(get(ui.state, "model", "models"));
  if (e.name === "up") ui.sel[modelTab] = max0(ui.sel[modelTab]! - 1);
  else if (e.name === "down") ui.sel[modelTab] = max0(Math.min(all.length - 1, ui.sel[modelTab]! + 1));
  else if (s === "e" || e.name === "return") openForm(modelForm());
}

export const crlfRe = /[\r\n]+/g;
export const linkRe = /^https?:\/\//;

// a paste whole: a link on the model tab opening [model] with it as url,
// anything else where typing goes
export function onPaste(text: string) {
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

export function listKey(s: string, e: KeyEv) {
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
        const what = isOff ? "home/ back to files/ beside the app" : "home/ into " + dir;
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

export function gitKey(s: string, e: KeyEv) {
  const hosts = objs(ui.state?.gitHosts);
  if (e.name === "up") ui.sel[gitTab] = max0(ui.sel[gitTab]! - 1);
  else if (e.name === "down") ui.sel[gitTab] = max0(Math.min(hosts.length - 1, ui.sel[gitTab]! + 1));
  else if (s === "h" && !readGitHost() && process.platform !== "linux") flash(c("offmesh")(writeGitHost(true)));
  else if (s === "h") {
    const on = !readGitHost();
    const text = on
      ? "make this host a git host (forgejo)? " + iniNote
      : "stop being a git host? phosphorus-git is removed, " + iniNote;
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
export function askGitSwitch(target: J) {
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

export function askStart() {
  const lock = obj(get(ui.state, "lock"));
  if (lock) {
    flash(c("warn")("already updating, started by " + str(lock.initiator)));
    return;
  }
  ui.confirm = { text: "network down for a while. continue?", onYes: () => askPassword("") };
}

export function askPassword(err: string) {
  ui.prompt = { label: "admin password", value: "", err, onSubmit: (pw) => void startChain(pw) };
  render();
}

export async function startChain(password: string) {
  const r = await chainPost("start", password);
  onLoop(() => {
    if (r.status === 401) askPassword("wrong password");
    else if (r.status === 409) flash(c("warn")("already updating, started by " + or(str(r.body.by), "another host")));
    else if (r.status !== 202) flash(c("offmesh")(or(str(r.body.error), `update didn't start (status ${r.status})`)));
    poll();
  });
}

export function updateKey(s: string) {
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

export function onKey(e: KeyEv) {
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

export function switchTab(i: number) {
  ui.tab = i;
  ui.scroll = 0;
  if (i === filesTab) poll();
}
