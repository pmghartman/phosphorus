'use strict';
// hesperus: the cli, run in the container by scripts/hesperus, reads from
// this host's /api/state, writes straight to config/

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parse } = require('../services');
const { FRONTEND_PORT } = require('../util');

const API = `http://127.0.0.1:${FRONTEND_PORT}`;
// the checkout's config/, read-write (/etc/hesperus a read-only mount)
const CONFIG_DIR = process.env.HESPERUS_CONFIG_DIR || '/repo/config';
const SERVICES_FILE = path.join(CONFIG_DIR, 'services.export');
const INI_FILE = path.join(CONFIG_DIR, 'hesperus.ini');
const BASE_DOMAIN = process.env.BASE_DOMAIN || '';
const REQUEST_MS = 2000;
const TABS = ['services', 'files', 'git', 'stats', 'model', 'projects', 'update'];
const MODEL_TAB = TABS.indexOf('model');
const PROJECTS_TAB = TABS.indexOf('projects');
const UPDATE_TAB = TABS.indexOf('update');
const STEP_LABEL = {
  pending: 'waiting', running: 'updating', ok: 'success', current: 'up to date',
  fail: 'failed', unreachable: 'unreachable', skipped: 'skipped',
};
// [files] and [git] host: rebuilt by the frontend on its own once saved
const INI_NOTE = 'saving rebuilds hesperus, terminals drop for a moment';
const REBUILDING = 'rebuilding hesperus';
// [model]: only gpu baked into the image
const MODEL_NOTE = 'all but gpu apply on the next tick, gpu rebuilds hesperus';
const GIB = 1024 ** 3;

// --- the web's look ----------------------------------------------------------
// style.css's tokens, light when the terminal's background is

const DARK = {
  bg: '#141414', fg: '#e0e0e0', muted: '#9d9d9d', accent: '#9f81cf', accent2: '#ce8755', dim: '#555555',
  glyphPurple: '#a371f7', glyphOrange: '#f0883e', border: '#2e2e2e', card: '#1b1b1b', tabbar: '#0c0c0c',
  online: '#3fb950', offmesh: '#f85149', warn: '#d29922',
  teal: '#6fb3a8', sage: '#93ad7d', sky: '#7fa0c9', rose: '#c98ba0', sand: '#c4ab78',
};
const LIGHT = {
  ...DARK, bg: '#ffffff', fg: '#1f1f23', muted: '#6b6b73', dim: '#b4b4bb', border: '#e4e4e7', card: '#f4f4f5', tabbar: '#f7f7f8',
};

let PAL = DARK;
// terminals known for 24-bit colour that don't all say so in COLORTERM
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || '')
  || ['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper', 'Tabby'].includes(process.env.TERM_PROGRAM);

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
// nearest of the 256 palette's cube and grey ramp, for terminals without 24-bit
// colour, #141414 rounded to black by the cube alone
const LEVELS = [0, 95, 135, 175, 215, 255];
function to256(v) {
  const idx = v.map((x) => (x < 48 ? 0 : x < 115 ? 1 : Math.floor((x - 35) / 40)));
  const g = Math.max(0, Math.min(23, Math.round((v[0] + v[1] + v[2]) / 3 / 10 - 0.8)));
  const dist = (w) => w.reduce((n, x, i) => n + (x - v[i]) ** 2, 0);
  const grey = 8 + 10 * g;
  return dist([grey, grey, grey]) < dist(idx.map((i) => LEVELS[i])) ? 232 + g : 16 + 36 * idx[0] + 6 * idx[1] + idx[2];
}
const color = (layer, h) => (TRUECOLOR ? `\x1b[${layer};2;${rgb(h).join(';')}m` : `\x1b[${layer};5;${to256(rgb(h))}m`);
const FG = (h) => color(38, h);
const BG = (h) => color(48, h);
let BASE = '';
// .git-lag .off: muted 55% into the border
let OFF = '';

// always the terminal's own background
const PAGE = '\x1b[49m';

// one helper per token, back to the page's fg after
const c = {};
function setTheme(light) {
  PAL = light ? LIGHT : DARK;
  BASE = `\x1b[0m${PAGE}${FG(PAL.fg)}`;
  OFF = mix(PAL.muted, PAL.border, 0.45);
  for (const [k, h] of Object.entries(PAL)) c[k] = (s) => `${FG(h)}${s}${FG(PAL.fg)}`;
}
setTheme(false);

// OSC 11: the terminal's own background, answered nearly everywhere, then DA1,
// answered everywhere, its reply the end of the wait
function queryBackground() {
  return new Promise((resolve) => {
    let got = '';
    const onData = (d) => {
      got += d;
      if (/\x1b\[\?[\d;]*c/.test(got)) finish();
    };
    const finish = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      const m = got.match(/\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i);
      resolve(m ? m.slice(1).map((h) => parseInt(h, 16) / (16 ** h.length - 1)) : null);
    };
    const timer = setTimeout(finish, 600);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdout.write('\x1b]11;?\x1b\\\x1b[c');
  });
}

// the terminal's own background (asked, else COLORFGBG), dark when neither says
async function pickTheme() {
  const bg = await queryBackground();
  const bgv = Number(String(process.env.COLORFGBG || '').split(';').pop());
  setTheme(bg ? 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2] > 0.5 : bgv === 7 || bgv === 15);
}
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const strike = (s) => `\x1b[9m${s}\x1b[29m`;
// a span on its own surface, then the page's again
const surface = (bgHex, fgHex = PAL.fg) => (s) => `${bgHex === PAL.bg ? PAGE : BG(bgHex)}${FG(fgHex)}${s}${PAGE}${FG(PAL.fg)}`;
// the caret: a block in the accent, as input's caret-color
const caret = () => surface(PAL.accent)(' ');

// .about-art: purple to orange and back across the word
function gradient(s) {
  const chars = [...s];
  return chars.map((ch, i) => {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0;
    return `${FG(mix(PAL.glyphPurple, PAL.glyphOrange, t < 0.5 ? t * 2 : (1 - t) * 2))}${ch}`;
  }).join('') + FG(PAL.fg);
}

// .is-self and .mesh-stat-dot: the square before a host's name
const selfMark = (name) => `${c.accent('■')} ${name}`;
const dot = (d) => `${(d.hesperus ? c.teal : c.dim)('■')} ${d.name}`;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const vlen = (s) => [...String(s).replace(ANSI, '')].length;
const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - vlen(s)))}`;

// cut to w visible columns, escapes kept
function cut(s, w) {
  let out = '';
  let n = 0;
  for (const part of String(s).split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) { out += part; continue; }
    const take = [...part].slice(0, Math.max(0, w - n));
    out += take.join('');
    n += take.length;
  }
  return out;
}
const fit = (s, w) => `${cut(s, w)}${BASE}`;

// word wrapped to w columns, every escape so far replayed at each new line's
// start, a word longer than w split, later lines indented by hang
function wrap(s, w, hang = 0) {
  s = String(s);
  if (vlen(s) <= w || w < 2) return [s];
  const out = [];
  let codes = '';
  let line = '';
  let n = 0;
  let room = w;
  const next = () => {
    out.push(line);
    line = `${' '.repeat(hang)}${codes}`;
    n = 0;
    room = Math.max(1, w - hang);
  };
  for (const tok of s.split(/(\x1b\[[0-9;?]*[A-Za-z]| +)/).filter(Boolean)) {
    if (tok.startsWith('\x1b[')) { codes += tok; line += tok; continue; }
    const chars = [...tok];
    if (tok[0] === ' ') {
      if (n + chars.length <= room) { line += tok; n += chars.length; } else if (n) next();
      continue;
    }
    if (n + chars.length > room && n) next();
    for (let i = 0; i < chars.length; i += room) {
      if (i) next();
      const part = chars.slice(i, i + room);
      line += part.join('');
      n += part.length;
    }
  }
  out.push(line);
  return out;
}

// what a view's cards may hold: the terminal less the margin and a card's frame
const inner = () => Math.max(20, (process.stdout.columns || 80) - 5);

// labels in sage, sel: the › row on the hover surface, max: rows shown round it,
// the widest columns narrowed to fit, their cells wrapped
function table(headers, rows, sel = -1, max = Infinity) {
  const w = headers.map((h, i) => Math.max(vlen(h), ...rows.map((r) => vlen(r[i] ?? ''))));
  const mark = sel >= 0;
  const room = inner() - (mark ? 2 : 0) - 2 * (w.length - 1);
  for (let over = w.reduce((a, x) => a + x, 0) - room; over > 0; over--) {
    const i = w.indexOf(Math.max(...w));
    if (w[i] <= 4) break;
    w[i] -= 1;
  }
  const lines = (cells, on) => {
    const parts = cells.map((cell, i) => wrap(cell ?? '', w[i]));
    return Array.from({ length: Math.max(...parts.map((p) => p.length)) }, (_, k) => `${mark ? `${on && !k ? c.accent('›') : ' '} ` : ''}`
      + `${parts.map((p, i) => pad(p[k] ?? '', w[i])).join('  ')}`);
  };
  const shown = rows.length > max ? Math.max(1, max - 1) : rows.length;
  const from = Math.max(0, Math.min(sel - Math.floor(shown / 2), rows.length - shown));
  const out = rows.slice(from, from + shown).flatMap((r, i) => (from + i === sel ? lines(r, true).map((l) => ({ sel: l })) : lines(r)));
  if (shown < rows.length) out.push(c.muted(`${mark ? '  ' : ''}${from + 1}-${from + shown} of ${rows.length}`));
  const head = headers.map((h, i) => cut(h, w[i]));
  return [c.sage(`${mark ? '  ' : ''}${head.map((h, i) => pad(h, w[i])).join('  ')}`), ...out];
}

const lineLen = (l) => vlen(typeof l === 'object' ? l.sel : l);

// a card: 1px of --border round it, its head in sage on the top edge
function panel(title, lines, w) {
  const b = c.border;
  const head = cut(title, w - 1);
  const top = title ? `${b('┌─')} ${c.sage(head)} ${b(`${'─'.repeat(Math.max(0, w - vlen(head) - 1))}┐`)}` : b(`┌${'─'.repeat(w + 2)}┐`);
  const row = (l) => (typeof l === 'object'
    ? `${b('│')}${surface(PAL.border)(` ${pad(l.sel, w)} `)}${b('│')}`
    : `${b('│')} ${pad(l, w)} ${b('│')}`);
  return [top, ...lines.flatMap((l) => (typeof l === 'object' ? [l] : wrap(l, w))).map(row), b(`└${'─'.repeat(w + 2)}┘`)];
}

// every card in a view one width, never past the terminal, a blank row between
function panels(list) {
  const items = list.filter(Boolean);
  const w = Math.min(inner(), Math.max(...items.map(([t, ls]) => Math.max(vlen(t) + 2, ...ls.map(lineLen)))));
  return items.flatMap(([t, ls], i) => [...(i ? [''] : []), ...panel(t, ls, w)]);
}

// .update-actions buttons, each framed, accent for primary, red for danger,
// groups split by a rule, onto another row once past width
function buttons(groups, width) {
  const rows = [];
  let out;
  let used = 0;
  const start = () => { out = ['', '', '']; rows.push(out); used = 0; };
  start();
  groups.map((g) => g.filter(Boolean)).filter((g) => g.length).forEach((items, gi) => {
    items.forEach(([label, kind], i) => {
      const text = { primary: c.accent, danger: c.offmesh, quiet: c.muted }[kind] || ((s) => s);
      const frame = { primary: c.accent, danger: c.offmesh, quiet: c.border }[kind] || c.muted;
      const n = vlen(label) + 2;
      let gap = !used ? '' : gi && !i ? `  ${c.border('│')} ` : ' ';
      if (used && used + vlen(gap) + n + 2 > width) { start(); gap = ''; }
      const sp = label.indexOf(' ');
      out[0] += `${gap}${frame(`┌${'─'.repeat(n)}┐`)}`;
      out[1] += `${gap}${frame('│')}${text(` ${sp > 0 ? `${bold(label.slice(0, sp))}${label.slice(sp)}` : label} `)}${frame('│')}`;
      out[2] += `${gap}${frame(`└${'─'.repeat(n)}┘`)}`;
      used += vlen(gap) + n + 2;
    });
  });
  return rows.flatMap((r) => r.map((l) => ` ${l}`));
}

// --- config files -----------------------------------------------------------
// section-level edits, so comments, order and every other section stay put

function splitSections(text) {
  const head = [];
  const sections = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^\[\s*(.*?)\s*\]$/);
    if (m) { cur = { name: m[1], lines: [line] }; sections.push(cur); continue; }
    (cur ? cur.lines : head).push(line);
  }
  return { head, sections };
}

const joinSections = (doc) => [...doc.head, ...doc.sections.flatMap((s) => s.lines)].join('\n');

function keyOf(line) {
  const t = line.trim();
  const eq = t.indexOf('=');
  return t && !/^[#;]/.test(t) && eq > 0 ? t.slice(0, eq).trim() : null;
}

function fieldsOf(sec) {
  const f = {};
  for (const line of sec.lines.slice(1)) {
    const k = keyOf(line);
    if (k) f[k] = line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
  }
  return f;
}

// vals: key -> value, null drops the key, new keys after the last one
function rewriteSection(sec, name, vals, order) {
  const out = [`[${name}]`];
  const done = new Set();
  let after = 1;
  for (const line of sec.lines.slice(1)) {
    const k = keyOf(line);
    if (k && k in vals) {
      done.add(k);
      if (vals[k] !== null) { out.push(`${k} = ${vals[k]}`.trimEnd()); after = out.length; }
      continue;
    }
    out.push(line);
    if (k) after = out.length;
  }
  const extra = order.filter((k) => !done.has(k) && vals[k] != null).map((k) => `${k} = ${vals[k]}`.trimEnd());
  out.splice(after, 0, ...extra);
  return out;
}

// one blank line before it, one trailing newline after
function appendSection(doc, name) {
  const last = doc.sections.length ? doc.sections[doc.sections.length - 1].lines : doc.head;
  while (last.length && !last[last.length - 1].trim()) last.pop();
  if (last.length) last.push('');
  const sec = { name, lines: [`[${name}]`, ''] };
  doc.sections.push(sec);
  return sec;
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

// temp then rename, the frontend re-reading mid-write, owner and mode
// kept, else a root-owned file in the host's checkout
function writeAtomic(file, text) {
  let st = null;
  try { st = fs.statSync(file); } catch {}
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.hesperus-${process.pid}`);
  fs.writeFileSync(tmp, text);
  try {
    if (st) { fs.chmodSync(tmp, st.mode & 0o7777); fs.chownSync(tmp, st.uid, st.gid); }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// --- services.export ----------------------------------------------------------

const SVC_KEYS = ['port', 'scheme', 'mode', 'base_path', 'extras', 'type', 'start', 'stop'];

function serviceForm(sec) {
  const f = sec ? fieldsOf(sec) : {};
  const field = (key, hint, choices) => ({ key, value: f[key] || '', hint, choices });
  return {
    kind: 'service',
    title: sec ? `editing [${sec.name}]` : 'new service',
    orig: sec ? sec.name : null,
    idx: 0,
    error: '',
    fields: [
      { key: 'name', value: sec ? sec.name : '', hint: 'lowercase letters, digits, -' },
      field('port', 'required, 1-65535'),
      field('scheme', 'blank = http', ['', 'http', 'https']),
      field('mode', 'blank = path, subdomain = <name>.' + BASE_DOMAIN, ['', 'path', 'subdomain']),
      field('base_path', 'sub-path stripped before proxying'),
      field('extras', 'JSON: {"max_body":"50MB","forwarded_proto":"https"}'),
      field('type', 'blank, or game', ['', 'game']),
      field('start', 'games only: host command behind play'),
      field('stop', 'games only: host command behind stop'),
    ],
  };
}

const formValues = (form) => JSON.stringify(form.fields.map((f) => f.value));

// the neighbouring service, in file order, unsaved changes asked about first
function switchService(dir) {
  const form = ui.form;
  const secs = splitSections(readText(SERVICES_FILE)).sections;
  if (!secs.length) return;
  const at = form.orig === null ? (dir > 0 ? -1 : secs.length) : secs.findIndex((s) => s.name === form.orig);
  const next = (at + dir + secs.length) % secs.length;
  const go = () => {
    ui.sel[0] = next;
    const idx = form.idx;
    openForm(serviceForm(secs[next]));
    ui.form.idx = idx;
  };
  if (formValues(form) === form.initial) { go(); return; }
  ui.confirm = { text: `discard changes to ${form.orig === null ? 'the new service' : `[${form.orig}]`}?`, danger: true, onYes: go };
}

// the whole candidate file through the frontend's own parser, so a bad
// edit never reaches disk and blackholes the file
function saveService(form) {
  const v = Object.fromEntries(form.fields.map((f) => [f.key, f.value.trim()]));
  if (!v.name) return 'name is required';
  if (!v.port) return 'port is required';
  if (v.type === 'game' && !v.start !== !v.stop) return 'start and stop go together';
  if (v.type !== 'game' && (v.start || v.stop)) return 'start and stop are for games only';
  const doc = splitSections(readText(SERVICES_FILE));
  let sec = form.orig === null ? null : doc.sections.find((s) => s.name === form.orig);
  if (form.orig !== null && !sec) return `[${form.orig}] is gone from the file, reopen it`;
  if (!sec) sec = appendSection(doc, v.name);
  const vals = Object.fromEntries(SVC_KEYS.map((k) => [k, v[k] || null]));
  sec.lines = rewriteSection(sec, v.name, vals, SVC_KEYS);
  return commitServices(doc);
}

function deleteService(name) {
  const doc = splitSections(readText(SERVICES_FILE));
  doc.sections = doc.sections.filter((s) => s.name !== name);
  return commitServices(doc);
}

function commitServices(doc) {
  const text = joinSections(doc);
  const out = parse(text);
  if (out.error) return out.error;
  try { writeAtomic(SERVICES_FILE, text); } catch (e) { return `can't write ${SERVICES_FILE}: ${e.message}`; }
  return '';
}

// --- hesperus.ini [files] -----------------------------------------------------------

const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// unset perms full access, as the frontend reads them
function readShares() {
  const sec = splitSections(readText(INI_FILE)).sections.find((s) => s.name === 'files');
  const f = sec ? fieldsOf(sec) : {};
  const perms = splitList(f.priv);
  return splitList(f.dir).map((dir, i) => ({ dir, perms: perms[i] === undefined ? 'rwd' : perms[i] }));
}

function writeShares(shares) {
  const doc = splitSections(readText(INI_FILE));
  const sec = doc.sections.find((s) => s.name === 'files') || appendSection(doc, 'files');
  const vals = shares.length
    ? { dir: shares.map((s) => s.dir).join(', '), priv: shares.map((s) => s.perms).join(', ') }
    : { dir: '', priv: null };
  sec.lines = rewriteSection(sec, 'files', vals, ['dir', 'priv']);
  try { writeAtomic(INI_FILE, joinSections(doc)); } catch (e) { return `can't write ${INI_FILE}: ${e.message}`; }
  return '';
}

function shareForm(i) {
  const s = i === null ? { dir: '', perms: '' } : readShares()[i];
  return {
    kind: 'share',
    title: i === null ? 'new share' : `edit share ${s.dir}`,
    orig: i,
    idx: 0,
    error: '',
    fields: [
      { key: 'dir', value: s.dir, hint: 'host path, never / or a home directory' },
      { key: 'perms', value: s.perms, hint: 'r browse, w upload/rename, d delete', choices: ['r', 'rw', 'rwd'] },
    ],
  };
}

function saveShare(form) {
  const [dir, perms] = form.fields.map((f) => f.value.trim());
  if (!dir) return 'dir is required';
  if (dir.includes(',')) return "dir can't contain a comma";
  if (!/^[rwd]+$/.test(perms) || new Set(perms).size !== perms.length) return 'perms is a mix of r, w and d';
  const shares = readShares();
  if (form.orig === null) shares.push({ dir, perms });
  else shares[form.orig] = { dir, perms };
  return writeShares(shares);
}

// --- hesperus.ini [git] -------------------------------------------------------------

function readGitHost() {
  const sec = splitSections(readText(INI_FILE)).sections.find((s) => s.name === 'git');
  return !!sec && fieldsOf(sec).host === 'true';
}

function writeGitHost(on) {
  const doc = splitSections(readText(INI_FILE));
  const sec = doc.sections.find((s) => s.name === 'git') || appendSection(doc, 'git');
  sec.lines = rewriteSection(sec, 'git', { host: on ? 'true' : 'false' }, ['host']);
  try { writeAtomic(INI_FILE, joinSections(doc)); } catch (e) { return `can't write ${INI_FILE}: ${e.message}`; }
  return '';
}

// --- hesperus.ini [model] -----------------------------------------------------------

// host, gpu and url always written, ctx and slots only once set
const MODEL_KEYS = ['host', 'gpu', 'url', 'ctx', 'slots'];
const MODEL_KEPT = ['host', 'gpu', 'url'];
const BOOL_KEYS = ['host', 'gpu'];

function readModel() {
  const sec = splitSections(readText(INI_FILE)).sections.find((s) => s.name === 'model');
  const f = sec ? fieldsOf(sec) : {};
  // the flags never blank, so the form's choices always have somewhere to start
  return Object.fromEntries(MODEL_KEYS.map((k) => [k, f[k] || (BOOL_KEYS.includes(k) ? 'false' : '')]));
}

function writeModel(vals) {
  const doc = splitSections(readText(INI_FILE));
  const sec = doc.sections.find((s) => s.name === 'model') || appendSection(doc, 'model');
  const out = Object.fromEntries(MODEL_KEYS.map((k) => {
    const v = (vals[k] || '').trim();
    return [k, v || (MODEL_KEPT.includes(k) ? '' : null)];
  }));
  sec.lines = rewriteSection(sec, 'model', out, MODEL_KEYS);
  try { writeAtomic(INI_FILE, joinSections(doc)); } catch (e) { return `can't write ${INI_FILE}: ${e.message}`; }
  return '';
}

// the vm short of the machine the run script hands it whole, a tenth of slack
// for the vm's own kernel and rounding
const vmGap = (m) => m.machine > 0 && m.total < m.machine * 0.9;

// wsl's cap hesperus start writes itself, colima's set when its vm starts
const vmFix = () => (String(ui.state.self.platform || '').toLowerCase() === 'windows'
  ? 'hesperus start gives it all of it' : 'colima start --memory gives it all of it');

const ROLES = ['chimp', 'orangutan'];

// this host's [model], the roles set from the tab's list, c and a
function modelForm() {
  const m = readModel();
  const field = (key, hint, choices) => ({ key, value: m[key], hint, choices });
  return {
    kind: 'model', title: '[model]', idx: 0, error: '', gpuWas: m.gpu,
    fields: [
      field('host', 'true downloads the model here and runs it for the whole mesh', ['false', 'true']),
      field('gpu', 'true offloads it to this nvidia gpu, the rest in ram', ['false', 'true']),
      field('url', 'download link to a single .gguf, pasted or typed, a hugging face page link works too'),
      field('ctx', 'context tokens, blank is 65536, and every token costs memory'),
      field('slots', 'asks answered at once, sharing ctx, blank is 4'),
    ],
  };
}

// as the daemon reads it: https, a path ending .gguf
function linkOk(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && decodeURIComponent(u.pathname).endsWith('.gguf');
  } catch {
    return false;
  }
}

function saveModel(form) {
  const v = { ...readModel(), ...Object.fromEntries(form.fields.map((f) => [f.key, f.value.trim()])) };
  if (v.ctx && !(Number.isInteger(Number(v.ctx)) && Number(v.ctx) >= 512)) return 'ctx is a whole number of tokens, 512 or more';
  for (const k of BOOL_KEYS) if (!['true', 'false'].includes(v[k])) return `${k} is true or false`;
  if (v.slots && !(Number.isInteger(Number(v.slots)) && Number(v.slots) >= 1)) return 'slots is a whole number, 1 or more';
  if (v.url && !linkOk(v.url)) return 'url is a https link to a single .gguf';
  return writeModel(v);
}

// --- the API -------------------------------------------------------------------

async function call(pathname, opts = {}) {
  const r = await fetch(`${API}${pathname}`, { ...opts, signal: AbortSignal.timeout(REQUEST_MS) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const chainPost = (action, password) => call('/api/update/chain', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(password === undefined ? { action } : { action, password }),
}).catch((e) => ({ status: 0, body: { error: e.message } }));

// --- UI state -------------------------------------------------------------------

const ui = {
  tab: 0,
  lastTab: 0,
  state: null,
  offline: false,
  filesInfo: null,
  // each list tab's selected row, the model tab's set to this host once
  sel: TABS.map(() => 0),
  modelPicked: false,
  // the orangutan's projects, every host's, and the picked one's whole record
  projects: [],
  project: null,
  // a bracketed paste so far, null outside one
  paste: null,
  room: 20,
  scroll: 0,
  form: null,
  confirm: null,
  prompt: null,
  flash: '',
  flashAt: 0,
};

function flash(msg) { ui.flash = msg; ui.flashAt = Date.now(); render(); }

// the frontend's own cadence, fast while anything moves
let pollTimer = null;
let polling = null;
function poll() {
  clearTimeout(pollTimer);
  // one request at a time, a poll asked for mid-flight run right after
  const p = (polling || Promise.resolve()).then(pollOnce).finally(() => { if (polling === p) polling = null; });
  polling = p;
  return p;
}

async function pollOnce() {
  clearTimeout(pollTimer);
  try {
    const { status, body } = await call('/api/state');
    if (status !== 200) throw new Error(`status ${status}`);
    ui.state = body;
    ui.offline = false;
    if (ui.tab === 1) {
      ui.filesInfo = await call(`/api/files/${body.self.host}/info`).then((r) => r.body, () => null);
    }
    if (ui.tab === PROJECTS_TAB) await pollProjects();
  } catch {
    ui.offline = true;
  }
  render();
  pollTimer = setTimeout(poll, (ui.state && ui.state.pollMs) || 500);
}

// --- screens ----------------------------------------------------------------------

function servicesView() {
  const st = ui.state;
  const text = readText(SERVICES_FILE);
  const doc = splitSections(text);
  const checked = parse(text);
  const own = new Map(st.routes.filter((r) => r.host === st.self.host).map((r) => [r.name, r]));
  ui.sel[0] = Math.max(0, Math.min(ui.sel[0], doc.sections.length - 1));
  const rows = doc.sections.map((sec) => {
    const f = fieldsOf(sec);
    const live = own.get(sec.name);
    const status = f.type === 'game'
      ? (live ? (live.status === 'online' ? c.online : c.warn)(live.status) : c.muted('not published'))
      : (live ? c.online('published') : c.warn('not answering'));
    const where = f.type === 'game' ? `${sec.name}.${st.gameZone}:${f.port}`
      : f.mode === 'subdomain' ? `${sec.name}.${BASE_DOMAIN}` : `${BASE_DOMAIN}/${st.self.host}/${sec.name}/`;
    return [sec.name, f.port || '', c.teal(f.type || f.mode || 'path'), c.muted(f.scheme || (f.type ? '' : 'http')), c.muted(where), status];
  });
  const lines = panels([
    checked.error && ['rejected', [
      c.offmesh(checked.error), c.offmesh('the frontend keeps publishing the last good version until it is fixed'),
    ]],
    ['services.export', rows.length
      ? table(['name', 'port', 'mode', 'scheme', 'address', 'live'], rows, ui.sel[0], ui.room - (checked.error ? 8 : 3))
      : [c.muted('no services declared')]],
  ]);
  return { lines, keys: [['a add', 'primary'], rows.length && ['e edit'], rows.length && ['d delete', 'danger']] };
}

function filesView() {
  const shares = readShares();
  const info = ui.filesInfo;
  ui.sel[1] = Math.max(0, Math.min(ui.sel[1], shares.length - 1));
  const published = info && info.shares ? [
    ...info.shares.map((s) => `${s.label}  ${c.teal(s.perms)}`),
    ...(info.shares.length ? [] : [c.muted('nothing')]),
    ...(info.wantDir ? ['', c.warn(`${REBUILDING} to publish ${info.wantDir}`)] : []),
  ] : null;
  const lines = panels([
    ['hesperus.ini [files]', shares.length
      ? table(['dir', 'perms'], shares.map((s) => [s.dir, c.teal(s.perms)]), ui.sel[1])
      : [c.muted(`using default dir: ${info && info.shares && info.shares[0] ? info.shares[0].label : "the repo's files"}`)]],
    published && ['published now', published],
  ]);
  return { lines, keys: [['a add', 'primary'], shares.length && ['e edit'], shares.length && ['d delete', 'danger']] };
}

function gb(bytes) { return `${(bytes / GIB).toFixed(1)}GB`; }

function ago(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// the git card's transfer bar: five cells a band, green to 8s, yellow to 15s, red to 60s
function lagMeter(ageSec) {
  let out = '';
  let empty = 0;
  for (const [paint, from, to] of [[c.online, 0, 8], [c.warn, 8, 15], [c.offmesh, 15, 60]]) {
    const full = Math.round(Math.max(0, Math.min(1, (ageSec - from) / (to - from))) * 5);
    if (full) out += paint('█'.repeat(full));
    empty += 5 - full;
  }
  return `${out}${FG(OFF)}${'░'.repeat(empty)}${FG(PAL.fg)}`;
}

// the card's glyphs: ● master, ○ servant ready, ◌ catching up, × unreachable
function gitRow(h, masterGen) {
  const master = h.role === 'master';
  const glyph = !h.reachable ? c.offmesh('×') : master ? c.accent('●') : !h.eligible ? c.sand('◌') : c.sage('○');
  const name = h.reachable ? h.host : c.muted(strike(h.host));
  let backup;
  if (!h.reachable) backup = 'unreachable';
  else if (h.gen == null || h.ageSec == null) backup = 'no data yet';
  else {
    const parts = [master ? 'live' : masterGen != null && h.gen < masterGen ? 'older lineage' : `${ago(h.ageSec)} behind`];
    if (!master && !h.eligible) parts.push('catching up');
    if (h.updating) parts.push('updating');
    backup = parts.join(' · ');
  }
  const meter = h.reachable && !master && h.ageSec != null ? lagMeter(h.ageSec) : '';
  return [`${glyph} ${name}`, c.muted(backup), meter];
}

// .mesh-stat-ping: green to 40ms, yellow to 150, red past it
function ping(ms) {
  if (typeof ms !== 'number') return c.muted('–');
  const v = Math.round(ms);
  return (v <= 40 ? c.online : v <= 150 ? c.warn : c.offmesh)(`${v}ms`);
}

function statsView() {
  const st = ui.state;
  const lock = st.lock;
  const lines = panels([
    lock && ['mesh update', [c.accent(`${lock.paused ? 'paused' : 'running'}, started by ${lock.initiator}`)]],
    ['tailnet', table(['host', 'os', 'version', 'ping'], [
      // this host usually in the tailnet list already, only added when missing
      ...(st.tailnet.some((d) => d.name === st.self.host) ? [] : [{ name: st.self.host, hesperus: true }]),
      ...st.tailnet,
    ].map((d) => {
      const self = d.name === st.self.host;
      return [
        self ? selfMark(d.name) : dot(d), c.teal((self ? st.self.platform : d.os) || ''),
        c.muted((self ? st.self.version : d.version) || ''), d.hesperus && !self ? ping(d.rttMs) : '',
      ];
    }))],
    ['routes', st.routes.length ? table(['host', 'name', 'mode', 'address', 'port', 'status'], st.routes.map((r) => [
      c.sky(r.host), r.name, c.teal(r.type === 'game' ? 'game' : r.mode),
      c.muted(r.type === 'game' ? `${r.name}.${st.gameZone}:${r.port}`
        : r.mode === 'subdomain' ? `${r.name}.${BASE_DOMAIN}${r.base_path ? `/${r.base_path}` : ''}`
          : `${BASE_DOMAIN}/${r.host}/${r.name}/`),
      c.muted(String(r.port)),
      r.type === 'game' ? (r.status === 'online' ? c.online : c.muted)(r.status || '') : c.online('up'),
    ])) : [c.muted('nothing published')]],
  ]);
  return { lines, keys: [['↑↓ scroll', 'quiet']], scroll: true };
}

// hesperus.ini's flag against what the mesh sees, the election as the git card draws it
function gitView() {
  const st = ui.state;
  const want = readGitHost();
  const live = st.gitHosts.some((h) => h.host === st.self.host);
  const hosts = st.gitHosts;
  const master = hosts.find((h) => h.role === 'master');
  ui.sel[2] = Math.max(0, Math.min(ui.sel[2], hosts.length - 1));
  const lines = panels([
    ['this host', [
      `${selfMark(st.self.host)}  git host ${want ? c.online('on') : c.muted('off')}`,
      ...(want !== live ? [c.warn(`${want ? 'not a git host yet' : 'still a git host'}; ${REBUILDING}`)] : []),
    ]],
    ['git hosts', hosts.length
      ? table(['host', 'state', 'behind'], hosts.map((h) => gitRow(h, master ? master.gen : null)), ui.sel[2])
      : [c.muted('none')]],
  ]);
  const target = hosts[ui.sel[2]];
  return {
    lines,
    keys: [['h toggle host', 'primary'], target && target.reachable && target.role !== 'master' && ['p make master']],
  };
}

// a model host's roles, as each now answers
const rolesOf = (x, model) => ROLES.filter((r) => x.host === model[r]);

// the model tab: this host's [model], every model on the mesh, anything wrong here
function modelView() {
  const st = ui.state;
  const all = st.model.models || [];
  const m = all.find((x) => x.host === st.self.host);
  const cfg = readModel();
  // starts on this host's own row
  if (!ui.modelPicked && m) { ui.sel[MODEL_TAB] = all.indexOf(m); ui.modelPicked = true; }
  ui.sel[MODEL_TAB] = Math.max(0, Math.min(ui.sel[MODEL_TAB], all.length - 1));
  const rows = all.map((x) => [
    x.host === st.self.host ? selfMark(x.host) : `${c.teal('■')} ${x.host}`,
    rolesOf(x, st.model).length ? c.accent(rolesOf(x, st.model).join(' + ')) : c.dim('-'),
    x.ready ? c.online('loaded') : x.download && x.download.total ? c.sand(`${Math.floor((100 * x.download.done) / x.download.total)}%`)
      : x.loading ? c.sand('loading') : c.warn('down'),
    x.ready && x.use && x.use.tps ? `${x.use.tps} tok/s` : c.dim('-'),
    x.file ? c.muted(x.file) : c.dim('no link'),
  ]);
  const dl = m && m.download && m.download.total ? m.download : null;
  const here = [
    `${selfMark(st.self.host)}  model host ${cfg.host === 'true' ? c.online('on') : c.muted('off')}`
      + `${cfg.host === 'true' ? `  ${c.muted(`gpu ${cfg.gpu} · slots ${cfg.slots || 4}`)}` : ''}`,
    ...(cfg.host === 'true' ? [cfg.url ? c.muted(cfg.url) : c.warn('no link yet, e to enter one')] : []),
    ...(m ? [
      ...(dl ? [`${bar(dl.done / dl.total)}  ${c.muted(`${gb(dl.done)} of ${gb(dl.total)}`)}`] : []),
      ...(!m.ready && m.why ? [c.warn(m.why)] : []),
      ...(vmGap(m) ? [c.warn(`docker's vm has ${gb(m.total)} of this machine's ${gb(m.machine)}; ${vmFix()}`)] : []),
    ] : []),
  ];
  // a peer's model picked in the table, why it's down under it
  const picked = all[ui.sel[MODEL_TAB]];
  // each role's model, chosen in the web's model card
  const roles = ROLES.map((r) => {
    const x = (st.model.roles || {})[r] || {};
    return `${c.accent(r.padEnd(10))}${x.model ? x.model : c.dim('none')}${x.ready || !x.why ? '' : `  ${c.warn(x.why)}`}`;
  });
  const lines = panels([
    ['roles', roles],
    ['this host', here],
    ['models', all.length ? [
      ...table(['host', 'role', 'state', 'speed', 'file'], rows, ui.sel[MODEL_TAB]),
      ...(picked && picked !== m && !picked.ready && picked.why ? [c.warn(picked.why)] : []),
    ] : [c.muted('no host runs a model')]],
  ]);
  return { lines, keys: [['e edit', 'primary']] };
}

// --- projects: the orangutan's, every host's ---------------------------------------

const PHASES = ['plan', 'execute', 'test', 'refine'];
const ENDED = { done: 'done', blocked: 'blocked', expired: 'out of time', stopped: 'stopped', failed: 'failed' };
const span = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const pickedProject = () => ui.projects[ui.sel[PROJECTS_TAB]] || null;

async function pollProjects() {
  const r = await call('/api/projects').catch(() => null);
  if (!r || r.status !== 200) return;
  ui.projects = (r.body.projects || []).sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.started - a.started);
  ui.sel[PROJECTS_TAB] = Math.max(0, Math.min(ui.sel[PROJECTS_TAB], ui.projects.length - 1));
  const p = pickedProject();
  ui.project = p ? await call(`/api/projects/${encodeURIComponent(p.host)}/${p.id}`).then((x) => (x.status === 200 ? x.body : null), () => null) : null;
}

const projectState = (p) => (p.status === 'running' ? (p.working ? c.accent('working') : p.paused ? c.warn(`paused, ${p.waiting || 'its model is away'}`) : c.accent('between rounds'))
  : (p.status === 'done' ? c.online : ['blocked', 'expired'].includes(p.status) ? c.warn : c.offmesh)(ENDED[p.status] || p.status));

function projectsView() {
  const list = ui.projects;
  const p = ui.project && pickedProject() && ui.project.id === pickedProject().id ? ui.project : null;
  const now = Date.now();
  const rows = list.map((x) => [
    x.title, c.sky(x.host), projectState(x), x.status === 'running' ? `${x.progress}%` : c.dim('-'),
    c.muted(x.status === 'running' ? `${span(x.deadline - now)} left` : span((x.ended || now) - x.started)),
  ]);
  let detail = null;
  if (p) {
    const live = p.status === 'running';
    const total = p.deadline - p.started;
    const used = (live ? now : p.ended || now) - p.started;
    const cycle = PHASES.map((ph) => (live && ph === p.phase ? bold(c.accent(ph)) : c.muted(ph))).join(c.dim(' › '));
    const head = [
      `${c.muted('state'.padEnd(6))}${projectState(p)}${live ? c.muted(` · round ${p.round}`) : ''}${p.model ? c.muted(` · ${p.model}`) : ''}`,
      `${c.muted('cycle'.padEnd(6))}${cycle}`,
      `${c.muted('done'.padEnd(6))}${bar(p.progress / 100)}  ${p.progress}%`,
      `${c.muted('time'.padEnd(6))}${bar(total ? used / total : 1)}  ${c.muted(live ? `${span(p.deadline - now)} left of ${span(total)}` : `${span(used)} of ${span(total)}`)}`,
      ...(p.note ? wrap(`${c.muted('now'.padEnd(6))}${p.note}`, inner() - 4, 6) : []),
      ...(p.final ? ['', ...wrap(p.final, inner() - 4)] : []),
    ];
    const tasks = p.tasks.map((t) => `${t.done ? c.online('[x]') : c.accent('[ ]')} ${t.done ? c.muted(t.text) : t.text}`);
    const left = Math.max(3, ui.room - rows.length - head.length - tasks.length - 12);
    const events = p.events.filter((e) => e.kind !== 'exec').slice(-left).reverse().map((e) => {
      const at = new Date(e.at).toTimeString().slice(0, 5);
      const tag = e.kind === 'report' ? e.phase || 'report' : e.kind === 'said' ? 'orangutan' : e.kind;
      const paint = ['error', 'failed', 'stopped'].includes(e.kind) ? c.offmesh : e.kind === 'paused' ? c.warn
        : e.kind === 'resumed' ? c.online : e.kind === 'said' ? c.accent : c.sage;
      return `${c.dim(at)} ${paint(tag.padEnd(9))} ${String(e.text).split('\n')[0]}`;
    });
    detail = [p.title, [...head, ...(tasks.length ? ['', ...tasks] : []), '', ...events]];
  }
  const lines = panels([
    ['projects', rows.length ? table(['title', 'host', 'state', 'done', 'time'], rows, ui.sel[PROJECTS_TAB], 8)
      : [c.muted('none yet, n starts one on this host')]],
    detail,
  ]);
  const live = p && p.status === 'running';
  return {
    lines,
    keys: [['n new', 'primary'], live && ['o note'], live && ['s stop', 'danger'], p && !live && ['d delete', 'danger']],
  };
}

function projectForm() {
  return {
    kind: 'project', title: `new project on ${ui.state.self.host}`, idx: 0, error: '',
    fields: [
      { key: 'title', value: '', hint: 'a few words' },
      { key: 'brief', value: '', hint: 'what to make and what done looks like, pasted or typed' },
      { key: 'hours', value: '72', hint: 'how long the orangutan has, up to 336' },
    ],
  };
}

const noteForm = (p) => ({ kind: 'note', title: `note for ${p.title}`, idx: 0, error: '', target: p, fields: [{ key: 'note', value: '', hint: 'read by the orangutan at its next round' }] });

const post = (pathname, body) => call(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .catch((e) => ({ status: 0, body: { error: e.message } }));
const said = (r, ok) => flash(r.status === 200 ? c.online(ok) : c.offmesh(r.body.error || `status ${r.status}`));

function saveProject(form) {
  const v = Object.fromEntries(form.fields.map((f) => [f.key, f.value.trim()]));
  if (!v.title || !v.brief) return 'a project needs a title and a brief';
  if (!(Number(v.hours) > 0)) return 'hours is a number above 0';
  post('/api/projects', { title: v.title, brief: v.brief, hours: Number(v.hours), by: process.env.USER || 'cli' })
    .then((r) => { said(r, 'started, the orangutan is on it'); poll(); });
  return '';
}

function saveNote(form) {
  const text = form.fields[0].value.trim();
  if (!text) return 'empty note';
  const p = form.target;
  post(`/api/projects/${encodeURIComponent(p.host)}/${p.id}/note`, { by: process.env.USER || 'cli', text }).then((r) => said(r, 'noted, read next round'));
  return '';
}

function projectsKey(str, key) {
  const p = pickedProject();
  if (key.name === 'up') ui.sel[PROJECTS_TAB] = Math.max(0, ui.sel[PROJECTS_TAB] - 1);
  else if (key.name === 'down') ui.sel[PROJECTS_TAB] = Math.min(ui.projects.length - 1, ui.sel[PROJECTS_TAB] + 1);
  else if (str === 'n') openForm(projectForm());
  else if (!p) { if (['o', 's', 'd'].includes(str)) flash(c.offmesh('no project picked')); return; }
  else if (str === 'o' || str === 's') {
    if (p.status !== 'running') { flash(c.offmesh(`${p.title} isn't running`)); return; }
    if (str === 'o') openForm(noteForm(p));
    else {
      ui.confirm = {
        text: `stop ${p.title}? the orangutan's work so far stays in its workspace`, danger: true,
        onYes: () => post(`/api/projects/${encodeURIComponent(p.host)}/${p.id}/stop`, { by: process.env.USER || 'cli' }).then((r) => { said(r, 'stopped'); poll(); }),
      };
    }
  } else if (str === 'd') {
    if (p.status === 'running') { flash(c.offmesh('stop it first')); return; }
    ui.confirm = {
      text: `delete ${p.title} and its workspace?`, danger: true,
      onYes: () => post(`/api/projects/${encodeURIComponent(p.host)}/${p.id}/delete`, {}).then((r) => { said(r, 'deleted'); poll(); }),
    };
  }
  if (key.name === 'up' || key.name === 'down') poll();
}

// the chain this host can see: its own, else a peer's
function liveChain(st) {
  if (st.chain && !st.chain.done) return { chain: st.chain, mine: !!st.chainMine };
  return { chain: null, mine: false };
}

// block cells in brackets, as the files transfer bar, narrower on a narrow terminal
function bar(frac, paint) {
  const n = Math.max(10, Math.min(30, inner() - 40));
  const full = Math.max(0, Math.min(n, Math.round(frac * n)));
  const p = paint || c.accent;
  return `${p(`[${'█'.repeat(full)}`)}${FG(OFF)}${'░'.repeat(n - full)}${p(']')}`;
}

// the walk's progress, a running host counted half
function progress(chain) {
  const total = chain.order.length;
  let done = 0;
  for (const m of chain.order) {
    const s = chain.results[m] || 'pending';
    done += s === 'running' ? 0.5 : s === 'pending' ? 0 : 1;
  }
  return `${bar(done / total)}  ${c.muted(`${Math.floor(done)}/${total} hosts`)}`;
}

function updateView() {
  const st = ui.state;
  const { chain, mine } = liveChain(st);
  const last = st.chain && st.chain.done ? st.chain : null;
  const shown = chain || last;
  const title = !chain ? (last ? 'mesh update finished' : 'mesh update') : chain.paused ? 'mesh update paused' : 'updating the mesh';
  // one that answered before is listed too, as not answering, rather than
  // dropping out of sight and out of the walk
  const names = st.tailnet.filter((d) => d.hesperus || d.hesperusSeen).map((d) => d.name);
  if (!names.includes(st.self.host)) names.push(st.self.host);
  const quiet = (m) => {
    const d = st.tailnet.find((x) => x.name === m);
    return m !== st.self.host && !!d && !!d.hesperusSeen && !d.hesperus;
  };
  const order = shown ? [...shown.order, ...names.filter((n) => !shown.order.includes(n))] : names.sort();
  // .update-row: muted while waiting, accent while running, a failure reds its step only
  const list = table(['host', 'version', ''], order.map((m) => {
    const d = st.tailnet.find((x) => x.name === m) || {};
    const self = m === st.self.host;
    const version = self ? st.self.version : d.version || '';
    const step = shown ? shown.results[m] || '' : '';
    const os = c.teal(self ? st.self.platform || '' : d.os || '');
    const row = {
      pending: c.muted, skipped: c.muted, running: c.accent, fail: c.offmesh, unreachable: c.offmesh,
    }[step] || ((s) => s);
    const bare = (step === 'fail' || step === 'unreachable' ? (x) => x : row)(step === 'skipped' ? strike(m) : m);
    const name = self ? `${c.accent('■')} ${bare}` : bare;
    const ver = version ? `v${version}` : '?';
    const verText = step ? c.muted(ver) : !shown && version !== st.self.version ? c.warn(ver) : ver;
    const label = ((step === 'fail' || step === 'unreachable') && shown.errors && shown.errors[m]) || STEP_LABEL[step] || step;
    if (!step && quiet(m)) return [`${name} ${os}`, c.muted(ver), c.offmesh('not answering')];
    const state = step === 'ok' || step === 'current' ? c.online(label) : row(label);
    return [`${name} ${os}`, verText, state];
  }));
  const lines = panels([
    chain && ['progress', [
      progress(chain),
      ...(!mine ? [c.muted(`started by ${chain.initiator}`)] : []),
    ]],
    [title, list],
  ]);
  const keys = chain
    ? (mine ? [chain.paused && ['c continue', 'primary'], ['x cancel', 'danger']] : [])
    : [['shift+u update', 'primary']];
  return { lines, keys };
}

function offlineView() {
  return panels([['offline', [
    c.offmesh(`the frontend is not answering on :${FRONTEND_PORT}`), '',
    c.muted('hesperus is down or restarting, start it with'), '', `  ${c.accent('hesperus start')}`, '',
    c.muted('this screen clears on its own once it answers'),
  ]]]);
}

// every service by name, the one being edited on the accent, widened out from
// it until the screen is full, … marking what's cut
function serviceStrip(form) {
  const names = splitSections(readText(SERVICES_FILE)).sections.map((s) => s.name);
  if (form.orig === null) names.push('+ new');
  const at = Math.max(0, names.indexOf(form.orig === null ? '+ new' : form.orig));
  const room = inner() - 4;
  const cell = (n) => vlen(n) + 3;
  let lo = at;
  let hi = at;
  let used = cell(names[at]);
  for (let grew = true; grew;) {
    grew = false;
    if (hi + 1 < names.length && used + cell(names[hi + 1]) <= room) { used += cell(names[++hi]); grew = true; }
    if (lo > 0 && used + cell(names[lo - 1]) <= room) { used += cell(names[--lo]); grew = true; }
  }
  const cells = names.slice(lo, hi + 1).map((n, i) => (lo + i === at ? bold(surface(PAL.accent, PAL.bg)(` ${n} `)) : c.muted(` ${n} `)));
  return `${lo > 0 ? c.muted('… ') : ''}${cells.join(' ')}${hi < names.length - 1 ? c.muted(' …') : ''}`;
}

// .update-pass: the value on the card surface, the accent marking focus
function formView(form) {
  const w = Math.max(...form.fields.map((f) => f.key.length));
  const hint = (f) => f.hint + (f.choices ? '  space cycles' : '');
  // values clipped to leave the hints a column of 24 where there's room, 7 =
  // marker, gaps and the value's padding
  const vw = Math.max(12, Math.min(inner() - 7 - w - 24, Math.max(...form.fields.map((f) => vlen(f.value) + 1))));
  const left = 7 + w + vw;
  // hints wrapped in their column, or under the field once that's too narrow
  const beside = inner() - left >= 36;
  const fields = form.fields.flatMap((f, i) => {
    const on = i === form.idx;
    const chars = [...f.value];
    // focused: the tail, where typing lands, otherwise the head
    const shown = chars.length < vw ? f.value
      : on ? `…${chars.slice(chars.length - vw + 2).join('')}` : `${chars.slice(0, vw - 1).join('')}…`;
    const value = on ? surface(PAL.card)(` ${pad(`${shown}${caret()}${BG(PAL.card)}`, vw)} `) : ` ${pad(shown || c.dim('-'), vw)} `;
    const head = `${on ? c.accent('›') : ' '} ${c.accent2(pad(f.key, w))} ${value}`;
    if (!beside) return [head, ...wrap(c.muted(hint(f)), inner() - 4).map((l) => `    ${l}`)];
    const [first, ...rest] = wrap(c.muted(hint(f)), inner() - left);
    return [`${head}  ${first}`, ...rest.map((l) => `${' '.repeat(left)}${l}`)];
  });
  const notes = [
    ...(form.kind === 'share' ? [c.muted(INI_NOTE)] : []),
    ...(form.kind === 'model' ? [c.muted(MODEL_NOTE)] : []),
    ...(form.error ? [c.offmesh(form.error)] : []),
  ];
  const strip = form.kind === 'service' && serviceStrip(form);
  const lines = panels([strip && ['services', [strip]], [form.title, fields], notes.length && ['notes', notes]]);
  return {
    lines,
    keys: [['enter save', 'primary'], ['esc cancel'], ['↑↓ field', 'quiet'], strip && ['←→ service', 'quiet']],
  };
}

// .tab-btn: muted on the tab bar, the active one whole on the row highlight,
// short of room, the rest by number alone
function tabBar(cols) {
  const draw = (short) => TABS.map((t, i) => (i === ui.tab
    ? surface(PAL.border)(bold(` ${FG(PAL.accent)}${i + 1}${FG(PAL.fg)} ${t} `))
    : surface(PAL.tabbar, PAL.muted)(short ? ` ${i + 1} ` : ` ${i + 1} ${t} `))).join(surface(PAL.tabbar, PAL.border)('│'));
  const tabs = vlen(draw(false)) <= cols ? draw(false) : draw(true);
  return `${tabs}${surface(PAL.tabbar)(' '.repeat(Math.max(0, cols - vlen(tabs))))}`;
}

function currentView() {
  if (ui.offline || !ui.state) return { lines: ui.offline ? offlineView() : [c.muted(' reaching the frontend...')], keys: [] };
  if (ui.form) return formView(ui.form);
  return [servicesView, filesView, gitView, statsView, modelView, projectsView, updateView][ui.tab]();
}

function render() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const st = ui.state;
  const title = ` ${gradient(st ? `hesperus v${st.self.version}` : 'hesperus')}`;
  const global = ui.form ? [] : [[`1-${TABS.length} tabs`, 'quiet'], [ui.tab === UPDATE_TAB ? 'u close' : 'u update tab', 'quiet'], ['q quit', 'quiet']];
  let status = [''];
  let row = null;
  if (ui.prompt) {
    const p = ui.prompt;
    status = [` ${p.error ? c.offmesh(p.error) : c.muted(p.label)} ${surface(PAL.card)(` ${'*'.repeat(p.value.length)}${caret()}${BG(PAL.card)} `)}`];
    row = buttons([[['enter send', 'primary'], ['esc cancel']]], cols - 1);
  } else if (ui.confirm) {
    status = wrap(` ${ui.confirm.text}`, cols, 1);
    row = buttons([[['y yes', ui.confirm.danger ? 'danger' : 'primary'], ['n no']]], cols - 1);
  } else if (ui.flash && Date.now() - ui.flashAt < 8000) {
    status = wrap(` ${ui.flash}`, cols, 1);
  }
  // title, tabs and a gap above, the status and framed buttons below, however
  // many rows they wrap to, a view drawn again if that moved its room
  let view = currentView();
  const footer = () => [...status, ...(row || buttons([view.keys || [], global], cols - 1))];
  let foot = footer();
  const room = Math.max(1, rows - 3 - foot.length);
  if (room !== ui.room) {
    ui.room = room;
    view = currentView();
    foot = footer();
  }
  let body = view.lines.map((l) => ` ${l}`);
  if (view.scroll) {
    ui.scroll = Math.max(0, Math.min(ui.scroll, body.length - room));
    body = body.slice(ui.scroll);
  }
  const out = [title, tabBar(cols), '', ...body.slice(0, room)];
  while (out.length < rows - foot.length) out.push('');
  out.push(...foot);
  process.stdout.write(`\x1b[H${out.slice(0, rows).map((l) => `${BASE}${fit(l, cols)}`).join('\x1b[K\r\n')}\x1b[K\x1b[J`);
}

// --- keys -------------------------------------------------------------------------

function formKey(str, key) {
  const form = ui.form;
  if (key.name === 'escape') { ui.form = null; return; }
  if (form.kind === 'service' && (key.name === 'left' || key.name === 'right')) {
    switchService(key.name === 'right' ? 1 : -1);
    return;
  }
  if (key.name === 'return') {
    form.error = { service: saveService, share: saveShare, model: saveModel, project: saveProject, note: saveNote }[form.kind](form);
    if (form.error) return;
    ui.form = null;
    if (form.kind === 'service') {
      const at = splitSections(readText(SERVICES_FILE)).sections.findIndex((x) => x.name === form.fields[0].value.trim());
      if (at >= 0) ui.sel[0] = at;
    }
    // only a share, or [model] gpu, changing what the container was built with
    const gpu = form.fields.find((f) => f.key === 'gpu');
    const rebuilds = form.kind === 'share' || (form.kind === 'model' && !!gpu && gpu.value.trim() !== form.gpuWas);
    if (form.kind === 'project' || form.kind === 'note') return;
    flash(c.online(rebuilds ? `saved, ${REBUILDING}` : 'saved, live on the next tick'));
    poll();
    return;
  }
  fieldKey(form, str, key);
}

// moving between fields, cycling choices and typing, any form
function fieldKey(form, str, key) {
  const f = form.fields[form.idx];
  const n = form.fields.length;
  if (key.name === 'up' || (key.name === 'tab' && key.shift)) { form.idx = (form.idx + n - 1) % n; return; }
  if (key.name === 'down' || key.name === 'tab') { form.idx = (form.idx + 1) % n; return; }
  // space for cycling choices, never typed into a field that has them
  if (str === ' ' && f.choices) {
    f.value = f.choices[(f.choices.indexOf(f.value) + 1) % f.choices.length];
    return;
  }
  // the model's choices only ever cycled, a stray key never landing in them
  if (f.choices && form.kind === 'model') return;
  if (key.name === 'backspace') { f.value = [...f.value].slice(0, -1).join(''); return; }
  if (str && !key.ctrl && !key.meta && str >= ' ' && str !== '\x7f') f.value += str;
}

// --- model: the roles from the list, [model] through its form ---------------------

function modelKey(str, key) {
  const all = ui.state.model.models || [];
  if (key.name === 'up') ui.sel[MODEL_TAB] = Math.max(0, ui.sel[MODEL_TAB] - 1);
  else if (key.name === 'down') ui.sel[MODEL_TAB] = Math.min(all.length - 1, ui.sel[MODEL_TAB] + 1);
  else if (str === 'e' || key.name === 'return') openForm(modelForm());
}

// a paste whole: a link on the model tab opening [model] with it as url,
// anything else where typing goes
function onPaste(text) {
  const clean = text.replace(/[\r\n]+/g, '');
  if (ui.prompt) { ui.prompt.value += clean; return; }
  const link = /^https?:\/\//.test(clean.trim());
  if (!ui.form && ui.tab === MODEL_TAB && link && !ui.offline && ui.state && !ui.confirm) openForm(modelForm());
  const form = ui.form;
  if (!form) return;
  const url = form.kind === 'model' && link ? form.fields.findIndex((f) => f.key === 'url') : -1;
  if (url >= 0) { form.idx = url; form.fields[url].value = clean.trim(); return; }
  const f = form.fields[form.idx];
  if (!f.choices) f.value += clean;
}

function listKey(str, key) {
  if (ui.tab === 0) {
    const secs = splitSections(readText(SERVICES_FILE)).sections;
    const sec = secs[ui.sel[0]];
    if (key.name === 'up') ui.sel[0] = Math.max(0, ui.sel[0] - 1);
    else if (key.name === 'down') ui.sel[0] = Math.min(secs.length - 1, ui.sel[0] + 1);
    else if (str === 'a') openForm(serviceForm(null));
    else if ((str === 'e' || key.name === 'return') && sec) openForm(serviceForm(sec));
    else if (str === 'd' && sec) {
      ui.confirm = {
        text: `delete [${sec.name}]?`, danger: true,
        onYes: () => { const err = deleteService(sec.name); flash(err ? c.offmesh(err) : c.online(`[${sec.name}] deleted`)); poll(); },
      };
    }
  } else if (ui.tab === 1) {
    const shares = readShares();
    if (key.name === 'up') ui.sel[1] = Math.max(0, ui.sel[1] - 1);
    else if (key.name === 'down') ui.sel[1] = Math.min(shares.length - 1, ui.sel[1] + 1);
    else if (str === 'a') openForm(shareForm(null));
    else if ((str === 'e' || key.name === 'return') && shares[ui.sel[1]]) openForm(shareForm(ui.sel[1]));
    else if (str === 'd' && shares[ui.sel[1]]) {
      const i = ui.sel[1];
      ui.confirm = {
        text: `stop publishing ${shares[i].dir}? ${INI_NOTE}`, danger: true,
        onYes: () => {
          const err = writeShares(shares.filter((_, j) => j !== i));
          flash(err ? c.offmesh(err) : c.online(`removed, ${REBUILDING}`));
        },
      };
    }
  } else if (ui.tab === 2) {
    gitKey(str, key);
  } else if (ui.tab === 3) {
    scrollKey(key);
  } else if (ui.tab === MODEL_TAB) {
    modelKey(str, key);
  } else if (ui.tab === PROJECTS_TAB) {
    projectsKey(str, key);
  } else if (ui.tab === UPDATE_TAB) {
    updateKey(str);
  }
}

function scrollKey(key) {
  if (key.name === 'up') ui.scroll = Math.max(0, ui.scroll - 1);
  else if (key.name === 'down') ui.scroll += 1;
}

// --- git: the flag in hesperus.ini, and the git card's make master -------------------

function gitKey(str, key) {
  const hosts = ui.state.gitHosts;
  if (key.name === 'up') ui.sel[2] = Math.max(0, ui.sel[2] - 1);
  else if (key.name === 'down') ui.sel[2] = Math.min(hosts.length - 1, ui.sel[2] + 1);
  else if (str === 'h') {
    const on = !readGitHost();
    ui.confirm = {
      text: on ? `make this host a git host (forgejo/litefs)? ${INI_NOTE}` : `stop being a git host? hesperus-git is removed, ${INI_NOTE}`,
      danger: !on,
      onYes: () => { const err = writeGitHost(on); flash(err ? c.offmesh(err) : c.online(`git host ${on ? 'on' : 'off'}; ${REBUILDING}`)); },
    };
  } else if (str === 'p') askGitSwitch(hosts[ui.sel[2]]);
}

// the card's dialog: a live master handing off, none force-promoting
function askGitSwitch(target) {
  if (!target || !target.reachable || target.role === 'master') return;
  const master = ui.state.gitHosts.find((h) => h.role === 'master' && h.reachable);
  ui.confirm = {
    text: master
      ? `${master.host} hands off to ${target.host}, git.${BASE_DOMAIN} down a few seconds. make master?`
      : `${target.host} force-promoted, roster reset to the hosts in view, only if the old master is gone. force-promote?`,
    danger: !master,
    onYes: async () => {
      const r = await call(`/api/githosts/${encodeURIComponent(target.host)}/force`, { method: 'POST' })
        .catch((e) => ({ status: 0, body: { error: e.message } }));
      flash(r.status === 200 ? c.online(`${target.host} is taking over`) : c.offmesh(`make master failed: ${r.body.error || `status ${r.status}`}`));
      poll();
    },
  };
}

// --- the mesh update: a thin client over /api/update/chain -------------------------

function askStart() {
  const lock = ui.state && ui.state.lock;
  if (lock) { flash(c.warn(`already updating, started by ${lock.initiator}`)); return; }
  ui.confirm = {
    text: 'network down for a while. continue?',
    onYes: () => askPassword(''),
  };
}

function askPassword(error) {
  ui.prompt = { label: 'update password', value: '', error, onSubmit: startChain };
  render();
}

async function startChain(password) {
  const r = await chainPost('start', password);
  if (r.status === 401) askPassword('wrong password');
  else if (r.status === 409) flash(c.warn(`already updating, started by ${r.body.by || 'another host'}`));
  else if (r.status !== 202) flash(c.offmesh(r.body.error || `update didn't start (status ${r.status})`));
  poll();
}

function updateKey(str) {
  const { chain, mine } = liveChain(ui.state);
  if (str === 'c' && mine && chain.paused) chainPost('continue').then(poll);
  else if (str === 'x' && mine) {
    ui.confirm = { danger: true, text: 'cancel the mesh update? the host in flight still finishes', onYes: () => chainPost('cancel').then(poll) };
  }
}

function onKey(str, key = {}) {
  if (key.ctrl && key.name === 'c') quit();
  // bracketed: a paste arriving whole, never as keys
  if (key.name === 'paste-start') { ui.paste = ''; return; }
  if (key.name === 'paste-end') { const t = ui.paste || ''; ui.paste = null; onPaste(t); render(); return; }
  if (ui.paste !== null) { ui.paste += str || ''; return; }
  if (ui.prompt) {
    const p = ui.prompt;
    if (key.name === 'escape') ui.prompt = null;
    else if (key.name === 'return') { ui.prompt = null; p.onSubmit(p.value); } else if (key.name === 'backspace') p.value = p.value.slice(0, -1);
    else if (str && !key.ctrl && str >= ' ') p.value += str;
  } else if (ui.confirm) {
    const c = ui.confirm;
    ui.confirm = null;
    if (str === 'y' || str === 'Y') c.onYes();
  } else if (ui.form) {
    if (!ui.offline) formKey(str, key);
  } else if (str === 'q') {
    quit();
  } else if (str === 'U') {
    switchTab(UPDATE_TAB);
    if (ui.state && !liveChain(ui.state).chain) askStart();
  } else if (str === 'u') {
    switchTab(ui.tab === UPDATE_TAB ? ui.lastTab : UPDATE_TAB);
  } else if (/^[1-9]$/.test(str || '') && Number(str) <= TABS.length) {
    switchTab(Number(str) - 1);
  } else if (key.name === 'tab' || key.name === 'right' || key.name === 'left') {
    const back = key.shift || key.name === 'left';
    switchTab((ui.tab + (back ? TABS.length - 1 : 1)) % TABS.length);
  } else if (!ui.offline && ui.state) {
    listKey(str, key);
  }
  render();
}

function openForm(form) {
  form.initial = formValues(form);
  ui.form = form;
  ui.flash = '';
}

function switchTab(i) {
  if (i !== ui.tab && ui.tab !== UPDATE_TAB) ui.lastTab = ui.tab;
  ui.tab = i;
  ui.scroll = 0;
  if (i === 1 || i === PROJECTS_TAB) poll();
}

// --- startup ------------------------------------------------------------------------

function quit(code = 0) {
  process.stdout.write('\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l');
  process.exit(code);
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('hesperus needs a terminal; run it as plain `hesperus`');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  // hesperus update all: straight to the start prompt, --tab keeping a reconnect's place
  const tabArg = args.indexOf('--tab');
  if (tabArg >= 0) ui.tab = Math.max(0, TABS.findIndex((t) => t.toLowerCase() === String(args[tabArg + 1]).toLowerCase()));
  if (args[0] === 'update-all') ui.tab = UPDATE_TAB;

  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
  process.stdin.setRawMode(true);
  await pickTheme();
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', onKey);
  process.stdout.on('resize', render);
  process.on('SIGTERM', () => quit(0));
  process.on('uncaughtException', (e) => {
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l');
    console.error(e);
    process.exit(1);
  });

  if (args[0] === 'update-all') {
    // the start prompt once the first poll says whether a chain already runs
    poll().then(() => { if (!ui.offline) { askStart(); render(); } });
  } else {
    poll();
  }
}

main().catch((e) => {
  process.stdout.write('\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l');
  console.error(e);
  process.exit(1);
});
