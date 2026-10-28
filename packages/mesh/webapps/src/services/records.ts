// what the mesh knows: etc/services/<id>/<host>.json, who installed it as which
import * as store from "@phosphorus/store";
import { obj } from "@phosphorus/util";
import { type Op, Ops } from "./scripts.ts";

// login and at which commit; etc/services/<id>/jobs/<host>.json, the step under way
// or last run there --------------------------------------------------------------

export type Record_ = { login: string; by: string; at: number; commit: string };

export const recordRel = (id: string, host: string) => `etc/services/${id}/${host}.json`;
export const jobRel = (id: string, host: string) => `etc/services/${id}/jobs/${host}.json`;

export function recordOf(id: string, host: string): Record_ | undefined {
  const o = obj(store.read(recordRel(id, host)));
  if (!o || typeof o.login !== "string") return;
  return {
    login: o.login,
    by: typeof o.by === "string" ? o.by : "",
    at: typeof o.at === "number" ? o.at : 0,
    commit: typeof o.commit === "string" ? o.commit : "",
  };
}

export function records(id: string): Record<string, Record_> {
  const out: Record<string, Record_> = {};
  for (const f of store.list(`etc/services/${id}`)) {
    if (f.includes("/")) continue;
    const host = f.replace(/\.json$/, "");
    const r = recordOf(id, host);
    if (r) out[host] = r;
  }
  return out;
}

// Job a step on one host: asked by by as login from the host from, started at at;
// done once the host has seen it end, ok or with error
export type Job = {
  id: string;
  host: string;
  op: Op;
  by: string;
  login: string;
  from: string;
  keep: boolean;
  at: number;
  done: number;
  ok?: boolean;
  error: string;
};

export function jobOf(id: string, host: string): Job | undefined {
  const o = obj(store.read(jobRel(id, host)));
  if (!o || typeof o.login !== "string" || !Ops.includes(o.op)) return;
  return {
    id,
    host,
    op: o.op,
    by: typeof o.by === "string" ? o.by : "",
    login: o.login,
    from: typeof o.from === "string" ? o.from : "",
    keep: o.keep === true,
    at: typeof o.at === "number" ? o.at : 0,
    done: typeof o.done === "number" ? o.done : 0,
    ok: typeof o.ok === "boolean" ? o.ok : undefined,
    error: typeof o.error === "string" ? o.error : "",
  };
}

export function jobs(id: string): Job[] {
  const out: Job[] = [];
  for (const f of store.list(`etc/services/${id}/jobs`)) {
    const j = jobOf(id, f.replace(/\.json$/, ""));
    if (j) out.push(j);
  }
  return out;
}

export const writeJob = (j: Job) =>
  store.write(jobRel(j.id, j.host), {
    op: j.op,
    by: j.by,
    login: j.login,
    from: j.from,
    keep: j.keep,
    at: j.at,
    done: j.done,
    ok: j.ok,
    error: j.error,
  });
