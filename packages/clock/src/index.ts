// the one cadence for every loop and the state push: fast while anything moves,
// idle once it settles
import { envInt } from "@phosphorus/util";

export const FastMS = envInt("POLL_INTERVAL_MS", 100);
export const IdleMS = envInt("IDLE_POLL_INTERVAL_MS", 500);
// how long one piece of news holds the fast rate
export const HotMS = envInt("POLL_HOT_MS", 3000);

let hotUntil = 0;
const listeners: (() => void)[] = [];

// woken on every piece of news
export const onHot = (fn: () => void) => void listeners.push(fn);

// news: the fast rate for HotMS
export function markHot() {
  hotUntil = Date.now() + HotMS;
  for (const fn of [...listeners]) fn();
}

export const isHot = () => Date.now() < hotUntil;
// the current loop interval
export const intervalMS = () => (isHot() ? FastMS : IdleMS);
