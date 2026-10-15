import {
  deskApps,
  dkCode,
  el,
  esc,
  harnessHosts,
  name,
  news,
  renderMd,
  send,
  ws,
  wsBase,
} from '../app.js';

// --- projects -----------------------------------------------------------------
// the orangutan's long projects, every host's: the list, one's live state, or a
// new one, pushed over a socket while the window is up

const pjList = document.getElementById('pj-list');
// a project's longest, as the server holds it
const PJ_MAX_HOURS = 14 * 24;
const pjHead = document.getElementById('pj-head');
const pjBody = document.getElementById('pj-body');
// a project's folder in its host's home
const pjWork = (p) => `shared/projects/${p.workspace || p.id}`;
// the workspace's files listed again at most this often, on news only
const PJ_FILES_MS = 3000;
const PJ_PHASES = ['plan', 'execute', 'test', 'refine'];
const PJ_ENDED = { done: 'done', blocked: 'blocked', expired: 'out of time', stopped: 'stopped', failed: 'failed' };
let pjAll = [];
let pjSelf = '';
// host/id, or 'new'
let pjPick = '';
let pjOne = null;
let pjSig = '';
let pjListSig = '';
let pjFiles = { key: '', at: 0, sig: '', list: [] };
let pjCmds = false;
// a stop or delete pressed once, waiting on the second press
let pjArmed = '';

const pjKey = (p) => `${p.host}/${p.id}`;
const pjFind = () => pjAll.find((p) => pjKey(p) === pjPick) || null;
const pjSpan = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const pjBar = (frac, n = 30) => {
  const k = Math.max(0, Math.min(n, Math.round(frac * n)));
  return `[<span class="pj-cells">${'█'.repeat(k)}<i>${'░'.repeat(n - k)}</i></span>]`;
};
const pjState = (p) => (p.status === 'running' ? (p.paused ? `paused, ${p.waiting || 'its model is away'}` : p.working ? 'working' : 'between rounds')
  : PJ_ENDED[p.status] || p.status);
const pjClock = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function pjGet(url) {
  const r = await fetch(url, { cache: 'no-store' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `status ${r.status}`);
  return body;
}
async function pjPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `status ${r.status}`);
  return out;
}

// the list as pushed or fetched, the pick settled on it
function pjTakeList(r) {
  pjSelf = r.self;
  pjAll = (r.projects || []).sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.started - a.started);
  if (!pjPick && pjAll.length) pjPick = pjKey(pjAll[0]);
  if (!pjPick && !pjAll.length) pjPick = 'new';
  pjPaintList();
}

function pjTakeOne(p) {
  if (!p || pjKey(p) !== pjPick) return;
  pjOne = p;
  pjPaintOne();
  pjLoadFiles();
}

// pushed while the window is up; a press's answer asked for at once
let pjWs = null;
let pjWsRetry = 0;
let pjTick = 0;
const pjWsOpen = () => pjWs?.readyState === WebSocket.OPEN;
const pjSendPick = (fresh) => pjWsOpen() && pjWs.send(JSON.stringify({ pick: pjPick === 'new' ? '' : pjPick, fresh }));

function pjConnect() {
  const ws = new WebSocket(`${wsBase()}/api/projects/ws`);
  pjWs = ws;
  ws.onopen = () => { pjWsRetry = 0; pjSendPick(false); };
  ws.onmessage = (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'list') {
      const was = pjPick;
      pjTakeList(m);
      if (pjPick !== was) pjSendPick(false);
      if (pjPick === 'new') pjPaintNew();
      else if (!pjFind() && pjPick) { pjOne = null; pjGo(pjAll.length ? pjKey(pjAll[0]) : 'new'); }
    } else if (m.type === 'one') pjTakeOne(m.project);
  };
  ws.onclose = () => {
    if (pjWs !== ws) return;
    pjWs = null;
    pjWsRetry = Math.min(10000, (pjWsRetry || 500) * 2);
    setTimeout(() => { if (deskApps.has('projects') && !pjWs) pjConnect(); }, pjWsRetry);
  };
}

async function pjPoll() {
  if (pjWsOpen()) { pjSendPick(true); return; }
  try {
    pjTakeList(await pjGet('/api/projects'));
    const p = pjFind();
    if (p) {
      pjOne = await pjGet(`/api/projects/${encodeURIComponent(p.host)}/${p.id}`).catch(() => pjOne);
      if (pjOne && pjKey(pjOne) !== pjPick) pjOne = null;
      pjPaintOne();
      pjLoadFiles();
    } else if (pjPick === 'new') pjPaintNew();
    else { pjOne = null; pjPick = pjAll.length ? pjKey(pjAll[0]) : 'new'; }
  } catch (e) {
    pjList.replaceChildren(el('div', 'cw-empty', `can't list projects: ${e.message}`));
  }
}

function pjWatch(on) {
  clearInterval(pjTick);
  pjTick = 0;
  if (!on) {
    const ws = pjWs;
    pjWs = null;
    ws?.close();
    return;
  }
  if (!pjWs) pjConnect();
  // times on screen kept current without asking anyone
  pjTick = setInterval(() => { pjPaintList(); pjPaintOne(); }, 30000);
}

function pjPaintList() {
  const sig = JSON.stringify([pjAll, pjPick, Math.floor(Date.now() / 60000)]);
  if (sig === pjListSig) return;
  pjListSig = sig;
  const head = el('div', 'cw-head');
  head.append(el('span', 'who-model', 'orangutan'));
  const add = Object.assign(el('button', 'cw-add', '+'), { type: 'button', title: 'new project (n)' });
  add.addEventListener('click', () => pjGo('new'));
  head.append(add);
  const rows = [head];
  if (!pjAll.length) rows.push(el('div', 'cw-empty', 'no projects yet'));
  for (const p of pjAll) {
    const b = Object.assign(el('button', `cw-item pj-item${pjKey(p) === pjPick ? ' on' : ''}`), { type: 'button' });
    b.dataset.pj = pjKey(p);
    const top = el('span', 'pj-item-top');
    top.append(el('span', 'cw-name', p.title), el('span', `cw-sub pj-st-${p.paused ? 'paused' : p.status}${p.working ? ' pj-working' : ''}`,
      p.paused ? 'paused' : p.status === 'running' ? `${p.progress}%` : PJ_ENDED[p.status] || p.status));
    const sub = el('span', 'pj-item-sub', `${p.host} · ${p.status === 'running' ? `${pjSpan(p.deadline - Date.now())} left` : pjClock(p.ended || p.started)}`);
    b.append(top, sub);
    b.addEventListener('click', () => pjGo(pjKey(p)));
    rows.push(b);
  }
  const focused = document.activeElement?.dataset?.pj;
  pjList.replaceChildren(...rows);
  if (focused) pjList.querySelector(`[data-pj="${CSS.escape(focused)}"]`)?.focus();
}

function pjGo(key) {
  if (key === pjPick) return;
  pjPick = key;
  pjOne = null;
  pjSig = '';
  pjArmed = '';
  pjFiles = { key: '', at: 0, sig: '', list: [] };
  pjListSig = '';
  pjPaintList();
  if (key === 'new') { pjPaintNew(); pjSendPick(false); } else { pjBody.replaceChildren(el('div', 'st-wait', 'loading')); pjPoll(); }
}

// --- one project ---

function pjPaintOne() {
  const p = pjOne;
  if (!p) return;
  const now = Date.now();
  const sig = JSON.stringify([p, pjFiles.list, pjCmds, pjArmed, Math.floor(now / 30000)]);
  if (sig === pjSig) return;
  pjSig = sig;
  pjHead.textContent = p.title;
  const live = p.status === 'running';
  const total = p.deadline - p.started;
  const used = (live ? now : p.ended || now) - p.started;
  const cycle = PJ_PHASES.map((ph) => `<span class="pj-ph${ph === p.phase && live ? ` on${p.working ? ' pj-working' : ''}` : ''}">${ph}</span>`).join('<span class="st-dim"> › </span>');
  const tasks = p.tasks.length ? p.tasks.map((t) => `<li class="${t.done ? 'done' : ''}"><span class="pj-box">${t.done ? '[x]' : '[ ]'}</span> ${esc(t.text)}</li>`).join('')
    : '<li class="st-dim">no tasks reported yet</li>';
  const events = p.events.filter((e) => pjCmds || e.kind !== 'exec').slice().reverse();
  const timeline = events.map((e) => {
    const tag = e.kind === 'report' ? (e.phase || 'report') : e.kind === 'said' ? 'orangutan' : e.kind;
    const text = e.kind === 'exec' ? `$ ${e.text}` : e.text;
    return `<li class="pj-ev pj-ev-${esc(e.kind)}"><span class="pj-ev-at">${esc(pjClock(e.at))}</span><span class="pj-ev-tag${e.kind === 'said' ? ' who-model' : ''}">${esc(tag)}</span>`
      + `<span class="pj-ev-text">${esc(text)}${e.n > 1 ? ` <span class="st-dim">×${e.n}</span>` : ''}</span></li>`;
  }).join('');
  const files = pjFiles.list.length ? pjFiles.list.map((f) => `<li><button type="button" class="pj-file" data-path="${esc(f.path)}"${f.dir ? ' disabled' : ''}>`
    + `${esc(f.path.slice(pjWork(p).length + 1))}</button></li>`).join('') : '<li class="st-dim">empty</li>';
  const row = (k, v) => `<div class="pj-row"><span class="st-key">${k}</span><span>${v}</span></div>`;
  const detail = el('div', 'pj-detail');
  detail.innerHTML = `<div class="pj-top">`
    + row('state', `<span class="pj-st-${p.paused ? 'paused' : p.status}${p.working && live ? ' pj-working' : ''}">${esc(pjState(p))}</span>${live ? ` <span class="st-dim">· round ${p.round}</span>` : ''}`)
    + row('where', `${esc(p.host)}${p.model ? ` <span class="st-dim">· ${esc(p.model)}</span>` : ''}${p.execs ? ` <span class="st-dim">· ${p.execs} commands</span>` : ''}`)
    + row('by', `${esc(p.by || 'someone')} <span class="st-dim">· ${esc(pjClock(p.started))}</span>`)
    + row('cycle', cycle)
    + row('done', `${pjBar(p.progress / 100)} ${p.progress}%`)
    + row('time', `${pjBar(total ? used / total : 1)} ${live ? `${pjSpan(p.deadline - now)} left of ${pjSpan(total)}${p.paused ? ', held while paused' : ''}` : `${pjSpan(used)} of ${pjSpan(total)}`}`)
    + (p.note ? row('now', esc(p.note)) : '')
    + `</div>`
    + (p.final ? `<div class="pj-sec"><div class="pj-sec-head">summary</div><div class="pj-final md"></div></div>` : '')
    + `<div class="pj-cols"><div class="pj-sec"><div class="pj-sec-head">tasks ${p.tasks.length ? `<span class="st-dim">${p.tasks.filter((t) => t.done).length}/${p.tasks.length}</span>` : ''}</div><ul class="pj-tasks">${tasks}</ul></div>`
    + `<div class="pj-sec"><div class="pj-sec-head">workspace <span class="st-dim">${esc(p.host)}/${esc(pjWork(p))}</span></div><ul class="pj-files">${files}</ul></div></div>`
    + `<div class="pj-sec"><div class="pj-sec-head">timeline <button type="button" class="st-clear pj-cmds">${pjCmds ? 'hide commands' : 'show commands'}</button></div><ul class="pj-events">${timeline}</ul></div>`
    + `<div class="pj-sec"><div class="pj-sec-head">brief</div><div class="pj-brief"></div></div>`;
  detail.querySelector('.pj-brief').textContent = p.brief;
  const fin = detail.querySelector('.pj-final');
  if (fin) renderMd(fin, p.final);
  const scroll = pjBody.querySelector('.pj-detail')?.scrollTop || 0;
  // the note box kept, never redrawn under a typing hand
  const had = pjBody.querySelector('.pj-acts');
  const acts = had && had.dataset.key === pjKey(p) ? had : pjActs(p);
  pjActsState(acts, p);
  const was = pjBody.querySelector('.pj-detail');
  if (was && acts === had) was.replaceWith(detail); else pjBody.replaceChildren(detail, acts);
  detail.scrollTop = scroll;
}

function pjActs(p) {
  const acts = el('form', 'pj-acts');
  acts.dataset.key = pjKey(p);
  const input = Object.assign(el('input', 'update-pass pj-note'), { type: 'text', placeholder: 'leave the orangutan a note for its next round', maxLength: 2000, autocomplete: 'off' });
  const send = Object.assign(el('button', 'primary pj-send', 'note'), { type: 'submit' });
  const stop = Object.assign(el('button', 'danger pj-stop', 'stop'), { type: 'button' });
  const del = Object.assign(el('button', 'danger pj-del', 'delete'), { type: 'button' });
  const more = Object.assign(el('button', 'pj-more', '+24h'), { type: 'button', title: 'give it another day' });
  const again = Object.assign(el('button', 'primary pj-again', 'restart'), { type: 'button', title: 'back to work in the same workspace, 72h' });
  const msg = el('span', 'pj-msg');
  const btns = el('div', 'update-actions');
  btns.append(msg, more, stop, del, again, send);
  acts.append(input, btns);
  acts.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    pjPost(`/api/projects/${encodeURIComponent(p.host)}/${p.id}/note`, { by: name, text })
      .then(() => { input.value = ''; msg.textContent = 'noted, read next round'; pjPoll(); }, (err) => { msg.textContent = err.message; });
  });
  stop.addEventListener('click', () => pjStop());
  del.addEventListener('click', () => pjDelete());
  const call = (op, body) => pjPost(`/api/projects/${encodeURIComponent(p.host)}/${p.id}/${op}`, { by: name, ...body }).then(pjPoll, (err) => { msg.textContent = err.message; });
  more.addEventListener('click', () => call('extend', { hours: 24 }));
  again.addEventListener('click', () => call('restart', { brief: input.value.trim() }));
  return acts;
}

function pjActsState(acts, p) {
  const live = p.status === 'running';
  acts.querySelector('.pj-note').hidden = !live;
  acts.querySelector('.pj-send').hidden = !live;
  acts.querySelector('.pj-stop').hidden = !live;
  acts.querySelector('.pj-del').hidden = live;
  acts.querySelector('.pj-more').hidden = !live;
  acts.querySelector('.pj-again').hidden = live;
  acts.querySelector('.pj-stop').textContent = pjArmed === 'stop' ? 'really stop?' : 'stop';
  acts.querySelector('.pj-del').textContent = pjArmed === 'delete' ? 'delete it and its workspace?' : 'delete';
}

// twice to confirm, the first press arming it a few seconds
function pjArm(what) {
  if (pjArmed === what) { pjArmed = ''; return true; }
  pjArmed = what;
  pjSig = '';
  pjPaintOne();
  setTimeout(() => { if (pjArmed === what) { pjArmed = ''; pjSig = ''; pjPaintOne(); } }, 4000);
  return false;
}

function pjStop() {
  const p = pjOne;
  if (!p || p.status !== 'running' || !pjArm('stop')) return;
  pjPost(`/api/projects/${encodeURIComponent(p.host)}/${p.id}/stop`, { by: name }).then(pjPoll, (e) => pjSay(e.message));
}

function pjDelete() {
  const p = pjOne;
  if (!p || p.status === 'running' || !pjArm('delete')) return;
  pjPost(`/api/projects/${encodeURIComponent(p.host)}/${p.id}/delete`, {}).then(() => { pjPick = ''; pjOne = null; pjPoll(); }, (e) => pjSay(e.message));
}

function pjSay(text) {
  const m = pjBody.querySelector('.pj-msg');
  if (m) m.textContent = text;
}

pjBody.addEventListener('click', (e) => {
  if (e.target.closest('.pj-cmds')) { pjCmds = !pjCmds; pjSig = ''; pjPaintOne(); return; }
  const f = e.target.closest('.pj-file');
  if (f && pjOne) dkCode({ host: pjOne.host, share: 'home', path: f.dataset.path, label: `${pjOne.host}/${f.dataset.path}` });
});

// the workspace's files, again only once something happened there
function pjLoadFiles() {
  const p = pjOne;
  if (!p) return;
  const key = pjKey(p);
  const news = `${p.events.length}:${p.events.at(-1)?.at || 0}`;
  if (pjFiles.key === key && (pjFiles.sig === news || Date.now() - pjFiles.at < PJ_FILES_MS)) return;
  pjFiles = { ...pjFiles, key, at: Date.now(), sig: news };
  pjGet(`/api/files/${encodeURIComponent(p.host)}/tree?share=home&path=${encodeURIComponent(pjWork(p))}&depth=4`).then((r) => {
    if (pjFiles.key !== key) return;
    pjFiles.list = (r.entries || []).filter((x) => !/(^|\/)(\.git|node_modules|__pycache__|\.venv)(\/|$)/.test(x.path))
      .map((x) => ({ path: x.path.replace(/\/$/, ''), dir: x.path.endsWith('/') })).filter((x) => !x.dir).slice(0, 200);
    pjPaintOne();
  }, () => {});
}

// --- a new one ---

function pjPaintNew() {
  if (pjBody.querySelector('.pj-new')) return;
  pjHead.textContent = 'new project';
  const form = el('form', 'pj-new');
  // one project a host: a busy one listed, not pickable
  const busy = new Set(pjAll.filter((p) => p.status === 'running').map((p) => p.host));
  const hosts = [...new Set(harnessHosts)].sort((x, y) => (y === pjSelf) - (x === pjSelf) || x.localeCompare(y));
  const first = hosts.find((h) => !busy.has(h)) || hosts[0] || '';
  form.innerHTML = '<p class="pj-intro">The <span class="who-model">orangutan</span> works on it alone in a sandbox on the model host picked, in rounds of plan, execute, test and refine, '
    + 'until it says it is done or the time runs out. It reports as it goes; its files land in shared/projects on that host.</p>'
    + (hosts.length ? '' : '<p class="pj-intro st-dim">no model host has opencode up yet, so there is nowhere to run one</p>')
    + '<input class="update-pass pj-title" type="text" placeholder="title" maxlength="120" autocomplete="off" required>'
    + '<textarea class="update-pass pj-brief-in" rows="12" placeholder="the brief: what to make, what done looks like, any constraints" maxlength="20000" required></textarea>'
    + '<div class="pj-opts"><label class="pj-host">host <select class="update-pass">'
    + hosts.map((h) => `<option value="${esc(h)}"${busy.has(h) ? ' disabled' : ''}${h === first ? ' selected' : ''}>${esc(h)}${busy.has(h) ? ' · busy' : ''}</option>`).join('')
    + '</select></label>'
    + `<label class="pj-hours">hours <input class="update-pass" type="number" min="0.1" max="${PJ_MAX_HOURS}" step="any" value="72"></label>`
    + `<span class="pj-ends st-dim"></span></div>`
    + '<div class="update-actions"><span class="pj-msg"></span><button type="submit" class="primary" disabled>start</button></div>';
  const title = form.querySelector('.pj-title');
  const brief = form.querySelector('.pj-brief-in');
  const hours = form.querySelector('.pj-hours input');
  const host = form.querySelector('.pj-host select');
  const go = form.querySelector('button[type="submit"]');
  // the deadline it would land on, and start only with a title, a brief and a free host
  const paint = () => {
    const h = Number(hours.value);
    const ok = h > 0 && h <= PJ_MAX_HOURS;
    form.querySelector('.pj-ends').textContent = ok
      ? `up to ${PJ_MAX_HOURS}, ends ${new Date(Date.now() + h * 3600000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).toLowerCase()}`
      : `0.1 to ${PJ_MAX_HOURS} hours`;
    go.disabled = !title.value.trim() || !brief.value.trim() || !ok || !host.value || busy.has(host.value);
  };
  form.addEventListener('input', paint);
  paint();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (go.disabled) return;
    const msg = form.querySelector('.pj-msg');
    msg.textContent = 'starting';
    pjPost('/api/projects', {
      title: title.value, brief: brief.value, hours: Number(hours.value) || 72, by: name, host: host.value,
    }).then((p) => { pjPick = pjKey(p); pjBody.replaceChildren(); pjPoll(); }, (err) => { msg.textContent = err.message; });
  });
  pjBody.replaceChildren(form);
}


export { pjWatch };
