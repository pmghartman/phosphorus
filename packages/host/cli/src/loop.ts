// ui state

import { call } from "./api.ts";
import { get, type J, num, obj, objs, str, truthy } from "./json.ts";
import { render } from "./render.ts";
import { filesTab, ui } from "./state.ts";

// the module's variables other modules set
export const loopVars = {
  finish: undefined as unknown as ((code: number) => void) | undefined,
  fail: undefined as unknown as ((e: unknown) => void) | undefined,
  // everything touching ui runs on the loop; after it ended, nothing does
  alive: false,
};

export function onLoop(f: () => void) {
  if (!loopVars.alive) return;
  try {
    f();
  } catch (e) {
    loopVars.fail?.(e);
  }
}

export function flash(msg: string) {
  ui.flash = msg;
  ui.flashAt = Date.now();
  render();
}

// a request asked of the poller, one in flight at a time, a poll asked for
// mid-flight run right after
export let poked = false;
export let pokeWake: (() => void) | undefined;

export function poll() {
  if (pokeWake) {
    const w = pokeWake;
    pokeWake = undefined;
    w();
  } else poked = true;
}

export async function poller() {
  while (loopVars.alive) {
    const every = await pollOnce();
    if (!loopVars.alive) return;
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

export async function pollOnce(): Promise<number> {
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
export let pingedAt = 0;

// pingHosts every host timed from this terminal, as the page times its own,
// null for one that didn't answer
export async function pingHosts(st: J) {
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
