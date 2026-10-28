// a step asked: started on the host over ssh, the job noted for the mesh
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import * as store from "@phosphorus/store";
import { errText, now, SelfHost } from "@phosphorus/util";
import { type Login, type Progress, seams } from "./mesh.ts";
import { type Job, jobOf, type Record_, recordRel, writeJob } from "./records.ts";
import {
  launch,
  launchTimeoutMS,
  logf,
  logTail,
  type Op,
  Ops,
  opTimeoutMS,
  type Service,
  Services,
  serviceOf,
} from "./scripts.ts";
import { behind } from "./versions.ts";

export const opWord: Record<Op, string> = {
  install: "installing on",
  update: "updating on",
  remove: "being removed from",
};

// ServiceOp an install, update or removal of id on host as login, asked by by:
// [status, body] once the step has started on the host, the host finishing it
export async function ServiceOp(
  op: string,
  id: string,
  host: string,
  login: Login,
  by: string,
  keep = false,
): Promise<[number, any]> {
  const s = serviceOf(id);
  if (!s) return [404, { error: `no service called ${id}` }];
  if (!Ops.includes(op as Op)) return [400, { error: "op is " + Ops.join(", ") }];
  const d = seams.tailnet().find((x) => x.name === host);
  if (!d || d.phosphorus !== true) return [404, { error: `${host} isn't a phosphorus host` }];
  const os = typeof d.os === "string" ? d.os : "";
  if (os && !s.os.includes(os)) return [400, { error: `${s.name} runs on ${s.os.join(", ")} hosts; ${host} is ${os}` }];
  if (!login.user) return [400, { error: `a login for ${host}` }];
  const held = jobOf(id, host);
  if (held && !held.done) return [409, { error: `${s.name} is already ${opWord[held.op]} ${host}`, job: held }];
  const j: Job = {
    id,
    host,
    op: op as Op,
    by,
    login: login.user,
    from: SelfHost,
    keep: keep && op === "remove",
    at: now(),
    done: 0,
    error: "",
  };
  let out = "";
  try {
    const code = await seams.run(host, login, launch(s, j.op, j.keep), (t) => void (out += t), launchTimeoutMS);
    if (code !== 0) throw new Error(`couldn't start it: ${out.trim().split("\n").at(-1) || `exit ${code}`}`);
  } catch (e) {
    return [502, { error: errText(e) }];
  }
  writeJob(j);
  logf("%s %s on %s as %s, for %s: %s", op, s.name, host, login.user, by, out.trim().split("\n").at(-1));
  return [200, { ok: true, job: j, started: out.trim() }];
}

export const jobsDir = (login: string) => join(seams.homeOf(login), ".phosphorus", "services", ".jobs");

// a file's last n bytes as text, "" when there's none
export function tailOf(p: string, n: number): string {
  let fd: number;
  try {
    fd = openSync(p, "r");
  } catch {
    return "";
  }
  try {
    const size = statSync(p).size;
    const start = size > n ? size - n : 0;
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const r = readSync(fd, buf, got, buf.length - got, start + got);
      if (!r) break;
      got += r;
    }
    let t = buf.subarray(0, got).toString("utf8");
    if (start > 0) t = t.slice(t.indexOf("\n") + 1);
    return t;
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

export const exitOf = (login: string, id: string): number | undefined => {
  const t = tailOf(join(jobsDir(login), id + ".exit"), 64).trim();
  return /^-?\d+$/.test(t) ? Number(t) : undefined;
};

// progress of the steps on this host, for its info: each service's job here, its log's tail
export function progress(): Record<string, Progress> {
  const out: Record<string, Progress> = {};
  if (!SelfHost) return out;
  for (const s of Services) {
    const j = jobOf(s.id, SelfHost);
    if (!j) continue;
    const p: Progress = { log: tailOf(join(jobsDir(j.login), s.id + ".log"), logTail) };
    const e = exitOf(j.login, s.id);
    if (e !== undefined) p.exit = e;
    out[s.id] = p;
  }
  return out;
}

// finish a step that ended here: its outcome published and recorded, the job done
export async function finish(s: Service, j: Job, exit: number | undefined) {
  try {
    if (exit === undefined) throw new Error(`ran past ${Math.round(opTimeoutMS[j.op] / 60000)} minutes`);
    if (exit !== 0) throw new Error(`the ${j.op} script exited ${exit}`);
    if (j.op === "remove") {
      const [st, b] = await seams.publishLocal(s.id, null);
      // nothing declared is as good as dropped
      if (st !== 200 && st !== 404 && !/no service/i.test(String(b?.error ?? "")))
        throw new Error(`unpublishing: ${b?.error ?? `status ${st}`}`);
      store.remove(recordRel(s.id, j.host));
    } else {
      const [st, b] = await seams.publishLocal(s.id, { port: String(s.port), mode: s.mode });
      if (st !== 200) throw new Error(`publishing: ${b?.error ?? `status ${st}`}`);
      const commit = tailOf(join(jobsDir(j.login), s.id + ".commit"), 64).trim();
      store.write(recordRel(s.id, j.host), { login: j.login, by: j.by, at: now(), commit } satisfies Record_);
      behind.delete(s.id + "/" + commit);
    }
    j.ok = true;
    logf("%s %s on %s: done", j.op, s.name, j.host);
  } catch (e) {
    j.ok = false;
    j.error = errText(e);
    logf("%s %s on %s: %s", j.op, s.name, j.host, j.error);
  }
  j.done = now();
  writeJob(j);
}

export let ticking: Promise<void> | undefined;

// tick the steps under way on this host: one that ended finished, one past its
// time failed
export function tick(): Promise<void> {
  return (ticking ??= (async () => {
    if (!SelfHost) return;
    for (const s of Services) {
      const j = jobOf(s.id, SelfHost);
      if (!j || j.done) continue;
      const exit = exitOf(j.login, s.id);
      if (exit !== undefined) await finish(s, j, exit);
      else if (now() - j.at > opTimeoutMS[j.op] + 60000) await finish(s, j, undefined);
    }
  })().finally(() => (ticking = undefined)));
}
