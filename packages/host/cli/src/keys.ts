// the home's .env: its keys typed blind, saved and phosphorus restarted on them
import { join } from "node:path";
import { osErrText } from "@phosphorus/config";
import { Keys as envKeys, read as readEnv, set as setEnv } from "@phosphorus/envfile";
import { env, RepoDir, spawnDetached } from "@phosphorus/util";
import { c } from "./draw.ts";
import { type Field, type Form, newForm } from "./form.ts";
import { ui } from "./state.ts";

// the home's .env, phosphorus run passing its path
export let envFile = env("PHOSPHORUS_ENV_FILE", join(RepoDir, ".env"));
export const setEnvFile = (file: string) => void (envFile = file);

export const keysNote = "values never shown, a blank field keeps what's set";
export const joinNote = "joining a mesh: TS_AUTHKEY alone, the rest copied from a peer";
export const keysNoteApply = "saving restarts phosphorus with them";
export const keysSaved = "saved, phosphorus restarting with them";

// every key blank and masked, the hint saying only whether one is set
export function keysForm(first: boolean): Form {
  const have = readEnv(envFile);
  const fields: Field[] = envKeys.map((k) => {
    const state = have[k.name] ? c("online")("set") : c("offmesh")("not set");
    return { key: k.name, value: "", hint: state + c("muted")(", " + k.hint), secret: true };
  });
  return newForm({ kind: "keys", title: first ? "keys, first start" : "keys", fields, first });
}

export function saveKeys(f: Form): string {
  const vals: Record<string, string> = {};
  for (const x of f.fields) {
    const v = x.value.trim();
    if (v !== "") vals[x.key] = v;
  }
  if (!vals.TS_AUTHKEY && !readEnv(envFile).TS_AUTHKEY) return "TS_AUTHKEY is needed, the rest can come from the mesh";
  if (Object.keys(vals).length === 0) return ui.keysOnly ? "" : "nothing typed, esc closes";
  try {
    setEnv(envFile, vals);
  } catch (e) {
    return "can't write " + envFile + ": " + osErrText(e);
  }
  return "";
}

// applyKeys phosphorus restarted on the new .env, by the home's own
// rebuild, its own session so quitting the cli never cuts it short
export function applyKeys() {
  spawnDetached([env("REBUILD_CMD", join(RepoDir, "bin", "phosphorus")), "rebuild", "--home", RepoDir]);
}
