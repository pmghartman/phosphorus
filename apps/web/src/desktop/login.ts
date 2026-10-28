// --- login: every host's user and password, any that answer enough
import { acctLogout, acctSave } from '../account.ts';
import { wsBase } from '../api.ts';
import { el, noFill } from '../dom.ts';
import { dk, st } from '../state.ts';
import { newSid } from '../util.ts';
import { dkArt, dkDesktop } from './desk.ts';
import { dkBar } from './taskbar.ts';

export const DK_USERS_KEY = 'phosphorus-dk-users';
const dkView = document.getElementById('view-desktop')!;

export function dkUsers(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(DK_USERS_KEY)!) || {}; } catch { return {}; }
}

// null once the host's shell answers, else why not, the session ended either way
export function dkProbe(host: string, user: string, pass: string): Promise<string | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase()}/api/term/${encodeURIComponent(host)}?${new URLSearchParams({ sid: newSid(), since: '0' })}`);
    ws.binaryType = 'arraybuffer';
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let text = '';
    let step = 0;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const lastLine = () => text.trim().split(/\r?\n/).filter(Boolean)[0];
    const done = (why: string | null) => {
      if (step === 3) return;
      step = 3;
      clearTimeout(settle!);
      clearTimeout(limit);
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close' }));
      ws.close();
      resolve(why);
    };
    const limit = setTimeout(() => done('no answer'), 15000);
    ws.onmessage = (e) => {
      text += dec.decode(e.data, { stream: true });
      if (step === 0 && /login: $/.test(text)) { step = 1; text = ''; ws.send(enc.encode(`${user}\r`)); }
      else if (step === 1 && /password: $/.test(text)) { step = 2; text = ''; ws.send(enc.encode(`${pass}\r`)); }
      else if (step === 2) {
        if (/login: $/.test(text)) return done(lastLine() || 'access denied');
        // the shell's first words, unless a refusal's prompt follows close behind
        if (text.trim()) { clearTimeout(settle!); settle = setTimeout(() => done(null), 250); }
      }
    };
    ws.onclose = () => done(lastLine() || `${host} didn't answer`);
  });
}

// one host's row on the login screen
export interface LoginRow { li: HTMLElement; user: HTMLInputElement; pass: HTMLInputElement; state: HTMLElement; host: string }

function dkLoginRow(host: string): LoginRow {
  const user = noFill(Object.assign(el('input'), { placeholder: 'user', spellcheck: false, value: dkUsers()[host] || '' }));
  const pass = noFill(Object.assign(el('input'), { placeholder: 'password' }), true);
  const state = el('span', 'dk-state');
  const li = el('li', 'dk-row');
  li.append(el('span', 'dk-host', host), user, pass, state);
  for (const input of [user, pass]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dkConnect(); } });
  return { li, user, pass, state, host };
}

export function dkLogin(): void {
  const list = el('ul', 'dk-rows');
  const go = Object.assign(el('button', 'primary', 'connect'), { type: 'button' });
  const box = el('div', 'dk-login');
  const actions = el('div', 'update-actions');
  actions.append(go);
  const skip = Object.assign(el('button', '', 'skip'), { type: 'button', title: 'log in to hosts later from their locks in the task bar' });
  const out = Object.assign(el('button', '', 'log out'), { type: 'button' });
  actions.prepend(out, skip);
  box.append(el('div', 'home-col-head', st.acct ? `desktop, ${st.acct.user}` : 'desktop'),
    el('p', 'dk-note', 'ssh logins'), list, actions);
  go.addEventListener('click', dkConnect);
  skip.addEventListener('click', dkDesktop);
  out.addEventListener('click', acctLogout);
  const stage = el('div', 'dk-stage');
  stage.appendChild(box);
  const desk = el('div', 'dk-desk');
  desk.append(dkArt(), stage, dkBar());
  dkView.replaceChildren(desk);
  dk.login = { list, go };
  dk.rows.clear();
  dkLoginHosts();
}

// rows kept as typed across a state push, only new hosts added
export function dkLoginHosts(): void {
  if (!dk.login) return;
  const hosts = [...st.terminalHosts].sort((a, b) => Number(b === st.selfHost) - Number(a === st.selfHost) || a.localeCompare(b));
  for (const h of hosts) if (!dk.rows.has(h)) dk.rows.set(h, dkLoginRow(h));
  const shown = hosts.map((h) => dk.rows.get(h)!.li);
  if (shown.length !== dk.login.list.children.length || shown.some((li, i) => dk.login!.list.children[i] !== li)) {
    dk.login.list.replaceChildren(...(shown.length ? shown : [el('li', 'empty', 'no hosts yet')]));
  }
}

async function dkConnect() {
  const tries = [...dk.rows.values()].filter((r) => r.user.value.trim() && r.pass.value && !dk.creds.has(r.host));
  if (!tries.length) {
    const first = [...dk.rows.values()].find((r) => !r.user.value.trim() || !r.pass.value);
    (first && !first.user.value.trim() ? first.user : first?.pass)?.focus();
    return;
  }
  dk.login!.go.disabled = true;
  const users = dkUsers();
  await Promise.all(tries.map(async (r) => {
    const user = r.user.value.trim();
    const pass = r.pass.value;
    r.state.className = 'dk-state busy';
    r.state.textContent = '…';
    const why = await dkProbe(r.host, user, pass);
    r.state.className = `dk-state ${why ? 'bad' : 'ok'}`;
    r.state.textContent = why || 'ok';
    r.state.title = why || '';
    if (why) { r.pass.value = ''; return; }
    dk.creds.set(r.host, { user, pass });
    users[r.host] = user;
    if (st.acct) st.acct.vault.hosts[r.host] = { user, pass };
  }));
  acctSave();
  try { localStorage.setItem(DK_USERS_KEY, JSON.stringify(users)); } catch {}
  if (!dk.login) return;
  dk.login.go.disabled = false;
  if (dk.creds.size) dkDesktop();
}

