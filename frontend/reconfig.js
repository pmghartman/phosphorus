'use strict';
// phos.ini's [files], [git] host and [model] host and gpu applied as soon as
// they're edited: baked into the container's mounts, profiles and image, hence a rebuild

const { execFile } = require('child_process');
const path = require('path');
const clock = require('./clock');
const { phosIni, readJson, writeJsonAtomic } = require('./util');

const STATE_DIR = process.env.STATE_DIR || '/state';
const APPLIED_FILE = path.join(STATE_DIR, 'reconfig.json');
const REBUILD_SCRIPT = process.env.REBUILD_SCRIPT || '/repo/scripts/rebuild.sh';
const REBUILD_TIMEOUT_MS = 1200000;
// an edit settled this long before a rebuild, so a burst of saves is one
const SETTLE_MS = 2000;

function log(msg) { console.log(`[reconfig] ${msg}`); }

const current = () => JSON.stringify({
  dir: phosIni('files', 'dir'), priv: phosIni('files', 'priv'), git: phosIni('git', 'host') === 'true',
  // the image's llama build and the search's profile, the rest of [model] read live by the daemon
  gpu: phosIni('model', 'gpu') === 'true', model: phosIni('model', 'host') === 'true',
});

// busy: an update's own rebuild under way, which reads phos.ini anyway
async function start(busy) {
  // first boot: whatever built this container
  if (!readJson(APPLIED_FILE, null)) writeJsonAtomic(APPLIED_FILE, { sig: current() });
  let seen = '';
  let since = 0;
  for (;;) {
    await clock.sleep(clock.IDLE_MS);
    const sig = current();
    if (sig !== seen) { seen = sig; since = Date.now(); continue; }
    if (sig === readJson(APPLIED_FILE, {}).sig || Date.now() - since < SETTLE_MS || busy()) continue;
    // recorded first: a swap killing this process, and no rerun on the next boot
    writeJsonAtomic(APPLIED_FILE, { sig });
    log('phos.ini [files], [git] or [model] host or gpu changed, rebuilding');
    await new Promise((resolve) => {
      // via bash, not the shebang: no exec bit on a bind mount from Windows
      execFile('bash', [REBUILD_SCRIPT], { timeout: REBUILD_TIMEOUT_MS }, (err, stdout, stderr) => {
        const out = String(stdout).trim().split('\n').pop();
        if (err) log(`rebuild failed: ${String(stderr || err.message).trim().split('\n').pop()}`);
        else if (out) log(out);
        resolve();
      });
    });
  }
}

module.exports = { start };
