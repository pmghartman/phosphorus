// a form: fields typed into, their keys and hints, and what it edits

export type Field = {
  key: string;
  value: string;
  hint: string;
  choices?: string[];
  // typed and pasted, never drawn
  secret?: boolean;
};

export type Form = {
  kind: string;
  title: string;
  // the service's section, or the share's index, -1 for new
  orig: string;
  isNew: boolean;
  origIdx: number;
  idx: number;
  err: string;
  fields: Field[];
  initial: string;
  gpuWas: string;
  hostWas: string;
  first: boolean;
};

export const newForm = (f: Partial<Form> & { kind: string; title: string; fields: Field[] }): Form => ({
  orig: "",
  isNew: false,
  origIdx: 0,
  idx: 0,
  err: "",
  initial: "",
  gpuWas: "",
  hostWas: "",
  first: false,
  ...f,
});

// every value, to tell an edited form from an untouched one
export const formValues = (f: Form) => JSON.stringify(f.fields.map((x) => x.value));

export function formVals(f: Form): Record<string, string> {
  const v: Record<string, string> = {};
  for (const x of f.fields) v[x.key] = x.value.trim();
  return v;
}
