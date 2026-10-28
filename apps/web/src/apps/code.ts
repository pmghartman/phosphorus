import { deskApps } from '../lib/state.ts';
import './code/state.ts';
import './code/frame.ts';
import './code/list.ts';
import './code/session.ts';
import './code/events.ts';
import './code/tools.ts';
import './code/diffs.ts';
import './code/todos.ts';
import './code/perms.ts';
import './code/composer.ts';
import './code/newsession.ts';
import './code/account.ts';
import { paintAcct } from './code/account.ts';
import { main } from './code/frame.ts';
import { loadList, loadOpts } from './code/list.ts';
import { connect, paintHead, paintOne } from './code/session.ts';
import { cd, LIST_MS } from './code/state.ts';

export function codeWatch(on: boolean): void {
  cd.on = on;
  clearInterval(cd.tick);
  cd.tick = 0;
  if (!on) {
    for (const t of cd.logs.values()) {
      t.closed = true;
      t.sock?.close();
      t.sock = null;
    }
    return;
  }
  loadOpts(true).then(() => {
    paintHead();
    paintAcct();
  });
  loadList().then(() => {
    if (cd.pick && cd.pick !== 'new' && !main.querySelector('.cd-log')) paintOne();
    else if (cd.pick !== 'new') {
      const t = cd.logs.get(cd.pick);
      if (t) {
        t.closed = false;
        connect(t);
      }
    }
  });
  cd.tick = setInterval(() => {
    if (!document.hidden && deskApps.has('code')) loadList();
  }, LIST_MS);
}
