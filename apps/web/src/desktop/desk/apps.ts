// the apps
import { app } from '../../apps/index.ts';
import { dk } from '../../lib/state.ts';
import { newSid } from '../../lib/util.ts';
import { type DkWin, dkFocus, dkWin } from '../windows.ts';

export function dkTerminal(host: string, run = '', shared = false): DkWin | undefined {
  const c = dk.creds.get(host);
  if (!c) return;
  const w = dkWin(null, 'terminal', host, 'term');
  if (!w) return;
  w.host = host;
  const t = app('terminal').then((m) =>
    m.startTerminal(w.body, host, newSid(), false, shared, { ...c, run }, { themeFrom: w.body }),
  );
  w.onFocus = () => t.then((x) => x.focus());
  w.onClose = () => t.then((x) => x.close());
  dkFocus(w);
  return w;
}
