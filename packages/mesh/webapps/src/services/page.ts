// the page's read
import { obj } from "@phosphorus/util";
import { iconPath } from "./icon.ts";
import { meshVars, type Progress, type Route, seams } from "./mesh.ts";
import { type Job, jobs, type Record_, records } from "./records.ts";
import { Services } from "./scripts.ts";
import { behind, behindMain, versionOf, versions } from "./versions.ts";

export type JobView = Job & Progress;
export type HostView = {
  published: boolean;
  route?: Route;
  version: string;
  record?: Record_;
  job?: JobView;
  behind: number | null;
};

export async function summary(): Promise<any[]> {
  const routes = seams.routes();
  return Promise.all(
    Services.map(async (s) => {
      const hosts: Record<string, HostView> = {};
      const at = (h: string) => (hosts[h] ??= { published: false, version: "", behind: null });
      for (const r of routes) {
        if (r.name !== s.id || r.type === "game") continue;
        const h = at(String(r.host));
        h.published = true;
        h.route = r;
      }
      for (const [h, rec] of Object.entries(records(s.id))) at(h).record = rec;
      for (const j of jobs(s.id)) {
        const p = obj(obj(seams.hostInfo(j.host)?.services)?.[s.id]);
        at(j.host).job = {
          ...j,
          log: typeof p?.log === "string" ? p.log : "",
          ...(typeof p?.exit === "number" ? { exit: p.exit } : {}),
        };
      }
      await Promise.all(
        Object.entries(hosts).map(async ([, h]) => {
          if (h.route) h.version = await versionOf(s, h.route);
          if (h.record?.commit) h.behind = await behindMain(s, h.record.commit);
        }),
      );
      return {
        id: s.id,
        name: s.name,
        tagline: s.tagline,
        about: s.about,
        features: s.features,
        category: s.category,
        by: s.by,
        repo: s.repo,
        icon: iconPath(s.id),
        port: s.port,
        mode: s.mode,
        os: s.os,
        needs: s.needs,
        agents: s.agents ?? [],
        data: s.data,
        checkout: `~/.phosphorus/services/${s.id}`,
        kept: `~/.phosphorus/services/${s.id}.data`,
        hosts,
      };
    }),
  );
}

// for tests: the caches forgotten
export function reset() {
  versions.clear();
  behind.clear();
  if (meshVars.ticker) clearInterval(meshVars.ticker);
  meshVars.ticker = undefined;
}
