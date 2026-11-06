// settings › network: the mesh's own control server picked, checked, and every
// host moved onto it together; join keys and device approvals asked of it
import * as peers from "@phosphorus/peers";
import * as store from "@phosphorus/store";
import { errText, now } from "@phosphorus/util";
import { selfHost } from "./config.ts";
import type { Res } from "./http.ts";
import { obj, str } from "./js.ts";
import { hostsInfo } from "./server.ts";

const ctl = peers.control;
type Control = peers.control.Control;

let healthAt = 0;
let healthOf = "";
let healthLast: { ok: boolean; why?: string } = { ok: false };

// <url>/health from here, over the internet as any device would reach it
async function health(url: string): Promise<{ ok: boolean; why?: string }> {
  if (healthOf === url && now() - healthAt < 10_000) return healthLast;
  let h: { ok: boolean; why?: string };
  try {
    const r = await fetch(url + "/health", { signal: AbortSignal.timeout(5000) });
    h = r.ok ? { ok: true } : { ok: false, why: `${url}/health said ${r.status}` };
  } catch (e) {
    h = { ok: false, why: `${url} not answering: ${errText(e)}` };
  }
  healthAt = now();
  healthOf = url;
  healthLast = h;
  return h;
}

const platformOf = (h: string) => str(obj(hostsInfo()[h])?.platform);

// the page's view: the choice, each phosphorus host's part in the move, the other devices
export async function controlStatus(): Promise<Res> {
  const c = ctl.control();
  const up = new Set([selfHost, ...peers.upPeers()]);
  const names = new Set([selfHost, ...Object.keys(hostsInfo())]);
  const hosts = [...names].sort().map((name) => {
    const hc = ctl.hostControl(name);
    return { name, platform: platformOf(name), up: up.has(name), on: hc?.on ?? "", ready: hc?.ready === true };
  });
  const others = peers
    .lastKnown()
    .filter((p) => !names.has(p.host))
    .map((p) => ({ name: p.host, os: p.os, online: p.online }));
  return [
    200,
    {
      control: c ?? null,
      self: selfHost,
      on: ctl.onControl(),
      hosted: ctl.HostedControl,
      health: c ? await health(c.url) : null,
      hosts,
      others,
    },
  ];
}

const nameRe = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// an admin's step: set, relay, prepare, switch, stop, join-key, approve
export async function controlAction(p: Record<string, unknown>): Promise<Res> {
  const c = ctl.control();
  const write = (next: Control) => store.write(ctl.controlRel, next, true);
  switch (str(p.action)) {
    case "set": {
      const host = str(p.host).toLowerCase();
      const name = str(p.name).toLowerCase().replace(/\.$/, "");
      if (!nameRe.test(name)) return [400, { error: "the control name must be a domain name, e.g. hs.example.com" }];
      if (!Object.keys(hostsInfo()).includes(host) && host !== selfHost)
        return [400, { error: `${host || "that"} isn't a phosphorus host` }];
      if (platformOf(host) !== "linux") return [400, { error: "the control server runs on a Linux host" }];
      if (c && c.stage !== "running" && c.stage !== "prepared")
        return [409, { error: "the mesh already moved; its control server stays where it is" }];
      const url = "https://" + name;
      write({ host, url, relay: c?.relay === true, stage: "running" });
      return [200, { ok: true }];
    }
    case "relay":
      if (!c) return [409, { error: "no control server yet" }];
      write({ ...c, relay: p.on === true });
      return [200, { ok: true }];
    case "prepare": {
      if (!c) return [409, { error: "no control server yet" }];
      if (c.stage !== "running") return [409, { error: `already ${c.stage}` }];
      const h = await health(c.url);
      if (!h.ok) return [409, { error: h.why ?? "the control server isn't answering" }];
      write({ ...c, stage: "prepared" });
      return [200, { ok: true }];
    }
    case "switch": {
      if (!c || c.stage !== "prepared") return [409, { error: "prepare first" }];
      const up = [selfHost, ...peers.upPeers()];
      const waiting = up.filter((h) => ctl.hostControl(h)?.ready !== true);
      if (waiting.length) return [409, { error: `not ready yet: ${waiting.join(", ")}` }];
      write({ ...c, stage: "switching", at: now() + 30_000, by: selfHost });
      return [200, { ok: true, at: now() + 30_000 }];
    }
    case "stop":
      if (!c) return [200, { ok: true }];
      if (c.stage !== "running" && c.stage !== "prepared")
        return [409, { error: "the mesh is on it now; it can't be turned off from here" }];
      store.remove(ctl.controlRel);
      return [200, { ok: true }];
    case "join-key":
      return ctl.controlOp("join-key");
    case "approve":
      return ctl.controlOp("approve", { authId: str(p.authId) });
  }
  return [400, { error: "action must be set, relay, prepare, switch, stop, join-key or approve" }];
}
