import { missing } from "@phosphorus/envfile";
import { env, errText, sleep } from "@phosphorus/util";
import { max0, setTheme, size } from "./draw.ts";
import { Parser } from "./input.ts";
import { indexOf } from "./json.ts";
import { keysForm, setEnvFile } from "./keys.ts";
import { openForm, tabs, ui, updateTab } from "./state.ts";
import { quitSignals, sigResize } from "./sys.ts";
import "./api.ts";
import "./loop.ts";
import "./render.ts";
import "./handlers.ts";
import { out } from "./api.ts";
import { askStart, onKey } from "./handlers.ts";
import { loopVars, onLoop, pokeWake, poller } from "./loop.ts";
import { glow, render } from "./render.ts";

export let quitting = false;

export function quit(code: number) {
  if (quitting) return;
  quitting = true;
  loopVars.finish?.(code);
}

// main runs the ui: update-all opens on the start prompt, --tab keeps a reconnect's place
export function main(args: string[]): Promise<number> {
  args.forEach((a, i) => {
    if (a === "--tab" && i + 1 < args.length) ui.tab = max0(indexOf(tabs, args[i + 1]!.toLowerCase()));
  });
  const updateAll = args.length > 0 && args[0] === "update-all";
  if (updateAll) ui.tab = updateTab;
  let later: (() => Promise<void>) | undefined;
  if (updateAll) {
    // the start prompt once the first poll says whether a chain already runs
    later = async () => {
      while (loopVars.alive && !(ui.state || ui.offline)) await sleep(50);
      onLoop(() => {
        if (!ui.offline) {
          askStart();
          render();
        }
      });
    };
  }
  return run(later, undefined);
}

// keys the key form alone, before phosphorus runs: 0 saved, 1 cancelled
export function keys(file: string): Promise<number> {
  setEnvFile(file);
  ui.keysOnly = true;
  return run(undefined, () => openForm(keysForm(missing(file).length > 0)));
}

// stdin's chunks queued until the loop takes them, null once it closed
export const chunks: (string | null)[] = [];
export let chunkWake: (() => void) | undefined;
export let sink: ((s: string | null) => void) | undefined;

export function deliver(s: string | null) {
  if (sink) sink(s);
  else {
    chunks.push(s);
    chunkWake?.();
  }
}

// a chunk, or ms gone by
export const waitChunk = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(() => {
      chunkWake = undefined;
      r();
    }, ms);
    chunkWake = () => {
      clearTimeout(t);
      chunkWake = undefined;
      r();
    };
  });

// run the terminal loop: later off the loop, first on it before the first frame,
// polling the frontend unless only the keys are asked for
export async function run(later?: () => Promise<void>, first?: () => void): Promise<number> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    process.stderr.write("phosphorus needs a terminal; run it as plain `phosphorus`\n");
    return 2;
  }
  try {
    stdin.setRawMode(true);
  } catch (e) {
    process.stderr.write(errText(e) + "\n");
    return 1;
  }
  const done = new Promise<number>((res, rej) => {
    loopVars.finish = res;
    loopVars.fail = rej;
  });
  loopVars.alive = true;
  const dec = new TextDecoder();
  const onData = (b: Uint8Array) => deliver(dec.decode(b, { stream: true }));
  const onEnd = () => deliver(null);
  const onResize = () => onLoop(render);
  const onSignal = () => quit(0);
  let tick: ReturnType<typeof setInterval> | undefined, shine: ReturnType<typeof setInterval> | undefined;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    loopVars.alive = false;
    out.write("\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l");
    try {
      stdin.setRawMode(false);
    } catch {}
    stdin.off("data", onData);
    stdin.off("end", onEnd);
    stdin.pause();
    if (sigResize) process.off(sigResize, onResize);
    for (const sig of quitSignals) process.off(sig, onSignal);
    clearInterval(tick);
    clearInterval(shine);
    // the poller woken to find the loop gone
    pokeWake?.();
  };
  try {
    out.write("\x1b[?1049h\x1b[?25l\x1b[?2004h");
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.resume();
    const rest = await pickTheme();

    if (sigResize) process.on(sigResize, onResize);
    for (const sig of quitSignals) process.on(sig, onSignal);
    if (!ui.keysOnly) void poller();
    if (later) void later();
    if (first) first();
    render();

    const p = new Parser();
    const feed = (s: string) => {
      for (const e of p.feed(s)) onKey(e);
    };
    sink = (s) => {
      if (s === null) {
        quit(0);
        return;
      }
      onLoop(() => feed(s));
    };
    for (const s of chunks.splice(0)) sink(s);
    onLoop(() => feed(rest));
    shine = setInterval(() => onLoop(glow), 100);
    let [cols, rows] = size();
    let minute = new Date().getMinutes();
    tick = setInterval(
      () =>
        onLoop(() => {
          // the flash line cleared once stale, a resize caught where no signal tells
          const [cc, rr] = size();
          const m = new Date().getMinutes();
          if (m !== minute) {
            minute = m;
            render();
          }
          const since = Date.now() - ui.flashAt;
          if (cc !== cols || rr !== rows || (ui.flash !== "" && since >= 8000 && since < 10000)) {
            cols = cc;
            rows = rr;
            render();
          }
        }),
      1000,
    );
    const code = await done;
    restore();
    return code;
  } catch (e) {
    restore();
    throw e;
  } finally {
    sink = undefined;
  }
}

// OSC 11: the terminal's own background, answered nearly everywhere, then DA1,
// answered everywhere, its reply the end of the wait; what came after it handed back
export const da1Re = /\x1b\[\?[\d;]*c/;
export const osc11Re = /\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(\x1b\\|\x07)?/i;

export async function pickTheme(): Promise<string> {
  out.write("\x1b]11;?\x1b\\\x1b[c");
  let got = "";
  const deadline = Date.now() + 600;
  while (!da1Re.test(got)) {
    if (chunks.length > 0) {
      // closed: left for the loop to see
      if (chunks[0] === null) break;
      got += chunks.shift();
      continue;
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await waitChunk(left);
  }
  let light: boolean;
  const m = osc11Re.exec(got);
  if (m) {
    const v = [1, 2, 3].map((i) => parseInt(m[i]!, 16) / (16 ** m[i]!.length - 1));
    light = 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]! > 0.5;
  } else {
    const parts = env("COLORFGBG").split(";");
    const bgv = parts[parts.length - 1];
    light = bgv === "7" || bgv === "15";
  }
  setTheme(light);
  got = got.replace(new RegExp(osc11Re.source, "gi"), "");
  return got.replace(new RegExp(da1Re.source, "g"), "");
}
