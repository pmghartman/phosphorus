// --- the control panel: the user's button; under it light, dark or black, the way to settings
// and log out
import { acctLogout, dkUserGlyph } from '../features/account.ts';
import { checkUpdates } from '../features/update.ts';
import { DK_GLYPHS, DK_UI, dkGlyph, el } from '../lib/dom.ts';
import { MODES, modeIcon, modePick, setTheme } from '../lib/scheme.ts';
import { dk, st } from '../lib/state.ts';
import { dkSettings } from '../settings/settings.ts';
import { dkAnchor, dkPopsClose, type Pop } from './taskbar.ts';

export function dkControlTray(): HTMLElement {
  const wrap = el('div', 'dk-tray-wrap dk-ctl');
  const b = Object.assign(el('button', 'dk-tray dk-profile'), {
    type: 'button',
    title: `${st.acct?.user || 'profile'}${st.acct?.admin ? ', admin' : ''}`,
    ariaLabel: 'control panel',
  });
  b.setAttribute('aria-expanded', 'false');
  b.append(dkUserGlyph(), el('span', 'dk-profile-name', st.acct?.user || ''));
  const pop = Object.assign(el('div', 'dk-ctl-pop dk-pop'), { hidden: true }) as Pop;
  wrap.append(b, pop);
  dkAnchor(pop, b, { fill: 240 });
  const draw = () => {
    const modes = el('div', 'dk-ap-segs dk-ctl-modes');
    for (const m of MODES) {
      const on = modePick() === m;
      const t = Object.assign(el('button', `dk-ap-seg${on ? ' on' : ''}`), { type: 'button', title: `${m} mode` });
      t.setAttribute('aria-pressed', String(on));
      t.append(modeIcon(m), m);
      t.addEventListener('click', () => {
        setTheme(m);
        draw();
      });
      modes.append(t);
    }
    // settings; a waiting release told on the bar's update button alone
    const set = Object.assign(el('button', 'dk-ctl-row'), { type: 'button' });
    set.append(
      dkGlyph(DK_GLYPHS.gear!, 'dk-ctl-row-ic'),
      el('span', 'dk-ctl-row-k', 'settings'),
      dkGlyph(DK_UI.fwd!, 'dk-ctl-row-ch'),
    );
    set.addEventListener('click', () => {
      show(false);
      dkSettings();
    });
    const head = el('div', 'dk-ctl-id');
    const who = el('div', 'dk-ctl-who');
    who.append(
      el('span', 'dk-ctl-name', st.acct?.user || 'profile'),
      el('span', 'dk-ctl-role', st.acct?.admin ? 'admin' : 'user'),
    );
    const out = Object.assign(el('button', 'dk-ctl-out'), { type: 'button', title: 'log out', ariaLabel: 'log out' });
    out.append(dkGlyph(DK_GLYPHS.power!));
    out.addEventListener('click', () => {
      show(false);
      acctLogout();
    });
    const avatar = el('span', 'dk-ctl-avatar');
    avatar.append(dkUserGlyph());
    head.append(avatar, who, out);
    pop.replaceChildren(head, modes, set);
  };
  const show = (on: boolean) => {
    if (!on && pop.hidden) return;
    if (on) dkPopsClose('ctl');
    pop.hidden = !on;
    b.setAttribute('aria-expanded', String(on));
    if (on) draw();
  };
  b.addEventListener('click', () => show(pop.hidden as boolean));
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!pop.hidden && !wrap.contains(e.target as Node)) show(false);
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) show(false);
  });
  dk.ctl = {
    show,
    btn: b,
    wrap,
    draw: () => {
      if (!pop.hidden) draw();
    },
  };
  setTimeout(checkUpdates, 3000);
  return wrap;
}
