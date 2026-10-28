// the ui's one state, every module reading and writing it on the loop
import type { Form } from "./form.ts";
import { formValues } from "./form.ts";
import type { J } from "./json.ts";

// the frontend's apps as tabs, the mesh update last, opened by u over them
export const tabs = ["status", "services", "files", "model", "git", "update"];
export const statsTab = 0, servicesTab = 1, filesTab = 2, modelTab = 3, gitTab = 4, updateTab = 5;
// shown the tabs on the bar, the update left off
export const shown = updateTab;

// [files] and [git] host: rebuilt by the frontend on its own once saved
export const iniNote = "saving rebuilds phosphorus, terminals drop for a moment";
export const rebuilding = "rebuilding phosphorus";
// [model]: only gpu baked into the image
export const modelNote = "url, ctx and slots apply on the next tick, host and gpu rebuild phosphorus";

export type Confirm = { text: string; danger?: boolean; onYes: () => void };
export type Prompt = { label: string; value: string; err: string; onSubmit: (v: string) => void };

export const ui = {
  tab: 0,
  // back the tab the update view returns to
  back: 0,
  state: undefined as J | undefined,
  offline: false,
  filesInfo: undefined as J | undefined,
  // each list tab's selected row, the model tab's set to this host once
  sel: tabs.map(() => 0),
  modelPicked: false,
  room: 20,
  scroll: 0,
  form: undefined as Form | undefined,
  confirm: undefined as Confirm | undefined,
  prompt: undefined as Prompt | undefined,
  flash: "",
  flashAt: 0,
  // the key form alone, before phosphorus runs
  keysOnly: false,
  // this terminal's round trip to each host, timed here
  rtt: {} as Record<string, unknown>,
};

export function openForm(f: Form) {
  f.initial = formValues(f);
  ui.form = f;
  ui.flash = "";
}
