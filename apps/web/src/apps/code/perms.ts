// permission requests: inline, answered once

import type { CodeWsMessage } from '@phosphorus/wire';
import { el } from '../../lib/dom.ts';
import { flushLive } from './events.ts';
import { call, sapi, type Transcript } from './state.ts';
import { toolArg, toolInput, toolName } from './tools.ts';

export function permCard(t: Transcript, m: CodeWsMessage) {
  flushLive(t);
  const c = el('div', 'cd-perm');
  const h = el('div', 'cd-perm-head');
  h.append(el('span', 'cd-perm-tag', 'permission'), el('span', 'cd-tool-name', toolName(m.tool || 'tool')));
  const arg = toolArg(m.tool!, m.input || {});
  if (arg) h.append(el('span', 'cd-tool-arg', arg));
  const body = el('div', 'cd-perm-body');
  if (m.reason) body.append(el('div', 'cd-perm-reason', m.reason));
  const shown = toolInput(m.tool!, m.input || {});
  body.append(
    ...(shown.length
      ? shown
      : [Object.assign(el('pre', 'cd-json'), { textContent: JSON.stringify(m.input || {}, null, 2) })]),
  );
  const why = Object.assign(el('input', 'cd-perm-why'), {
    type: 'text',
    placeholder: 'tell claude why, if denying (optional)',
    spellcheck: false,
  });
  why.addEventListener('keydown', (e) => e.stopPropagation());
  const acts = el('div', 'update-actions cd-perm-acts');
  const msg = el('span', 'cd-perm-msg');
  const btn = (label: string, cls: string, allow: boolean, always: boolean) => {
    const b = Object.assign(el('button', cls, label), { type: 'button' });
    b.addEventListener('click', () => {
      for (const x of acts.querySelectorAll('button')) x.disabled = true;
      msg.textContent = 'sending';
      call(sapi(t.id, 'permission'), 'POST', {
        reqId: m.reqId,
        allow,
        always,
        message: allow ? '' : why.value.trim(),
      }).then(
        () => done(allow, always),
        (e) => {
          msg.textContent = e.message;
          for (const x of acts.querySelectorAll('button')) x.disabled = false;
        },
      );
    });
    return b;
  };
  acts.append(
    msg,
    btn('deny', 'danger', false, false),
    btn('always allow', '', true, true),
    btn('allow once', 'primary', true, false),
  );
  c.append(h, body, why, acts);
  const done = (allow: boolean, always: boolean, cancelled?: boolean) => {
    if (c.classList.contains('answered')) return;
    c.classList.add('answered', allow ? 'allowed' : 'denied');
    why.remove();
    acts.replaceChildren(
      el(
        'span',
        `cd-perm-msg ${allow ? 'good' : cancelled ? '' : 'bad'}`,
        allow ? (always ? 'always allowed' : 'allowed') : cancelled ? 'no longer asked' : 'denied',
      ),
    );
  };
  t.perms.set(m.reqId!, { el: c, done });
  t.node.append(c);
}
