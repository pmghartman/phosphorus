// the forms over config/: services.export and phosphorus.ini's [files], [home] and
// [model], each saved through the same rewrites the frontend uses
import {
  editService,
  fieldsOf,
  isHomeDir,
  linkOk,
  readModel,
  readShares,
  readText,
  type Section,
  type Share,
  servicesFile,
  splitSections,
  wholeAtLeast,
  writeHomeDir,
  writeModel,
  writeShares,
} from "@phosphorus/config";
import { type Field, type Form, formVals, formValues, newForm } from "./form.ts";
import { openForm, servicesTab, ui } from "./state.ts";

// --- services.export ------------------------------------------------------------

export function serviceForm(s: Section | undefined): Form {
  const f = fieldsOf(s);
  const fl = (key: string, hint: string, ...choices: string[]): Field => ({
    key,
    value: f[key] ?? "",
    hint,
    choices: choices.length ? choices : undefined,
  });
  const out = newForm({ kind: "service", title: "new service", isNew: !s, fields: [] });
  let name = "";
  if (s) {
    out.title = "editing [" + s.name + "]";
    out.orig = s.name;
    name = s.name;
  }
  out.fields = [
    { key: "name", value: name, hint: "lowercase letters, digits, -" },
    fl("port", "required, 1-65535"),
    fl("scheme", "blank = whichever the port answers", "", "http", "https"),
    fl("max_body", "largest request body, e.g. 50MB; blank = no limit"),
    fl("public", "true = no phosphorus login, the service's own only", "", "true", "false"),
    fl("type", "blank, or game", "", "game"),
    fl("start", "games only: host command behind play"),
    fl("stop", "games only: host command behind stop"),
  ];
  return out;
}

// the neighbouring service in file order, unsaved changes asked about first
export function switchService(dir: number) {
  const f = ui.form!;
  const secs = splitSections(readText(servicesFile)).secs;
  const n = secs.length;
  if (n === 0) return;
  let at = -1;
  if (f.isNew) {
    if (dir < 0) at = n;
  } else {
    secs.forEach((s, i) => {
      if (s.name === f.orig) at = i;
    });
  }
  const next = (((at + dir) % n) + n) % n;
  const goTo = () => {
    ui.sel[servicesTab] = next;
    const idx = f.idx;
    openForm(serviceForm(secs[next]));
    ui.form!.idx = idx;
  };
  if (formValues(f) === f.initial) {
    goTo();
    return;
  }
  const what = f.isNew ? "the new service" : "[" + f.orig + "]";
  ui.confirm = { text: "discard changes to " + what + "?", danger: true, onYes: goTo };
}

// through config's editService, the whole candidate file checked before it's
// written, a renamed one renamed in place
export function saveService(f: Form): string {
  const { name, ...fields } = formVals(f);
  if (!name) return "name is required";
  return editService(name, fields, false, false, f.isNew ? name : f.orig)[0];
}

export const deleteService = (name: string) => editService(name, {}, true, false)[0];

// --- phosphorus.ini [files] -----------------------------------------------------

export function shareForm(i: number): Form {
  let s: Share = { dir: "", perms: "" };
  let title = "new share";
  if (i >= 0) {
    s = readShares()[i]!;
    title = "edit share " + s.dir;
  }
  return newForm({
    kind: "share",
    title,
    origIdx: i,
    isNew: i < 0,
    fields: [
      { key: "dir", value: s.dir, hint: "host path, never / or a home directory" },
      { key: "perms", value: s.perms, hint: "r browse, w upload/rename, d delete", choices: ["r", "rw", "rwd"] },
    ],
  });
}

const permsRe = /^[rwd]+$/;
const count = (s: string, ch: string) => s.split(ch).length - 1;

export function saveShare(f: Form): string {
  const dir = f.fields[0]!.value.trim(),
    perms = f.fields[1]!.value.trim();
  if (dir === "") return "dir is required";
  if (dir.includes(",")) return "dir can't contain a comma";
  if (!permsRe.test(perms) || count(perms, "r") > 1 || count(perms, "w") > 1 || count(perms, "d") > 1)
    return "perms is a mix of r, w and d";
  const shares = readShares();
  const wasHome = !f.isNew && isHomeDir(shares[f.origIdx]!.dir);
  if (f.isNew) shares.push({ dir, perms });
  else shares[f.origIdx] = { dir, perms };
  const err = writeShares(shares);
  if (err) return err;
  if (wasHome) return writeHomeDir(dir);
  return "";
}

// --- phosphorus.ini [model] -----------------------------------------------------

const boolKeys = ["host", "gpu"];

export function modelForm(): Form {
  const m = readModel();
  const fl = (key: string, hint: string, ...choices: string[]): Field => ({
    key,
    value: m[key] ?? "",
    hint,
    choices: choices.length ? choices : undefined,
  });
  return newForm({
    kind: "model",
    title: "[model]",
    gpuWas: m.gpu!,
    hostWas: m.host!,
    fields: [
      fl(
        "host",
        "true runs the model here for the whole mesh, downloading llama.cpp's llama-server (with NVIDIA's CUDA runtime on an nvidia gpu) and the model itself, several GB",
        "false",
        "true",
      ),
      fl("gpu", "true offloads it to this nvidia, amd or intel gpu, the rest in ram", "false", "true"),
      fl("url", "download link to a single .gguf, pasted or typed, a hugging face page link works too"),
      fl("ctx", "context tokens, blank is 65536, and every token costs memory"),
      fl("slots", "asks answered at once, sharing ctx, blank is 4"),
    ],
  });
}

export function saveModel(f: Form): string {
  const v = { ...readModel(), ...formVals(f) };
  if (v.ctx && !wholeAtLeast(v.ctx, 512)) return "ctx is a whole number of tokens, 512 or more";
  for (const k of boolKeys) if (v[k] !== "true" && v[k] !== "false") return k + " is true or false";
  if (v.slots && !wholeAtLeast(v.slots, 1)) return "slots is a whole number, 1 or more";
  if (v.url && !linkOk(v.url)) return "url is a https link to a single .gguf";
  return writeModel(v);
}
