'use strict';
// the one cadence for every loop and the state push: fast while anything
// moves, idle once it settles, since every host polls every other one

const FAST_MS = Number(process.env.POLL_INTERVAL_MS || 100);
const IDLE_MS = Number(process.env.IDLE_POLL_INTERVAL_MS || 500);
// how long one piece of news holds the fast rate, so a burst never flaps
const HOT_MS = Number(process.env.POLL_HOT_MS || 3000);

let hotUntil = 0;
// woken on every piece of news, e.g. the browsers' state push
const hotListeners = [];
const onHot = (fn) => hotListeners.push(fn);
const markHot = () => {
  hotUntil = Date.now() + HOT_MS;
  for (const fn of hotListeners) fn();
};
const isHot = () => Date.now() < hotUntil;
const intervalMs = () => (isHot() ? FAST_MS : IDLE_MS);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { FAST_MS, IDLE_MS, markHot, onHot, isHot, intervalMs, sleep };
