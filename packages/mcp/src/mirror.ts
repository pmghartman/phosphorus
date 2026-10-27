// a keyed call shown on the user's own pages as it happens: its start with the
// arguments, its end with the outcome; each user's sent in order, never holding the call
import { marshal, obj } from "@phosphorus/util";
import { src, str } from "./common.ts";

const mirrorQueue = 64;
const mirrorArg = 4000;
const mirrorOut = 64 << 10;

// arguments never put on a screen: a service's own auth
const mirrorHidden = new Set(["headers"]);

// tools whose output the page prints, as a console does
const mirrorPrinted = new Set([
  "terminal_run", "host_logs", "service_request", "forgejo", "host_config", "service_edit", "config_set", "host_power",
  "game_power", "terminal_screen",
]);

const queues = new Map<string, Record<string, any>[]>();

// mirror one step to user's pages on every host, dropped when they fall behind
export function mirror(user: string, step: Record<string, any>) {
  const send = src.actions?.userUIAsync;
  if (!send) return;
  step.kind = "agent";
  let q = queues.get(user);
  if (!q) queues.set(user, (q = []));
  if (q.length >= mirrorQueue) return;
  q.push(step);
  if (q.length > 1) return;
  (async () => {
    while (q.length) {
      try {
        await send(user, q[0]!);
      } catch {}
      q.shift();
    }
  })();
}

export function mirrorArgs(args: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (mirrorHidden.has(k)) continue;
    out[k] = typeof v === "string" ? clipBytes(v, mirrorArg, false) : v;
  }
  return out;
}

// mirrorEnd a call's outcome; a printed tool's shell output as typed, else its JSON, its tail kept
export function mirrorEnd(step: Record<string, any>, tool: string, out: unknown) {
  if (!mirrorPrinted.has(tool) || out === null || out === undefined) return;
  const m = obj(out);
  if (m) {
    step.exit = m.exit;
    step.timedOut = m.timedOut === true;
  }
  if (m && m.output !== null && m.output !== undefined) step.out = clipBytes(str(m.output), mirrorOut, true);
  else if (m && m.stdout !== null && m.stdout !== undefined) step.out = clipBytes(str(m.stdout) + str(m.stderr), mirrorOut, true);
  else if (m && m.screen !== null && m.screen !== undefined) step.out = clipBytes(str(m.screen), mirrorOut, true);
  else step.out = clipBytes(marshal(out), mirrorOut, true);
}

// clipBytes s to n bytes, its head or its tail, a split rune read as U+FFFD
export function clipBytes(s: string, n: number, tail: boolean): string {
  const b = Buffer.from(s);
  if (b.length <= n) return s;
  return tail ? b.subarray(b.length - n).toString("utf8") : b.subarray(0, n).toString("utf8") + "…";
}
