'use strict';
// the mesh's models: every host's claim, which is the chimp (small, quick) and
// which the orangutan (big, for long projects), opencode's calls passed to them

const http = require('http');
const path = require('path');
const harness = require('./harness');
const mesh = require('./mesh');
const { FRONTEND_PORT, readJson, readFresh, requestJson, writeJsonAtomic } = require('./util');

const SELF_HOST = process.env.SELF_HOST || '';
const STATE_DIR = process.env.STATE_DIR || '/state';
const CLAIM_FILE = path.join(STATE_DIR, 'model-claim.json');
const CLAIM_MAX_AGE_MS = 5000;
// each role's model and when it was chosen, the latest choice on the mesh winning
const ROLES_FILE = path.join(STATE_DIR, 'model-roles.json');
const KEYS_FILE = path.join(STATE_DIR, 'model-keys.json');
// the roles a model is asked as, more to come
const ROLES = ['chimp', 'orangutan'];
const { HANDLE, MESH } = harness;
const SERVER_PORT = Number(process.env.MODEL_SERVER_PORT || 8791);
const NAME_RE = /^[A-Za-z0-9-]{1,63}$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// provider/model, the model's own id free to hold more slashes
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}\/[^\s/]\S{0,199}$/i;
// who each role is, ahead of the system prompt the asker built
const IDENTITY = {
  chimp: `You are chimp, a chimpanzee: ${HANDLE}'s small, fast model, asked with /chimp. Your tools come first: `
    + 'reach for them before answering from memory, several at once when that is quicker, and when asked to do '
    + 'something, do it yourself with them (files, editors, terminals, views, games, models, messages). Then a short answer.',
  orangutan: `You are orangutan, an orangutan: ${HANDLE}'s big model, kept for long projects alone in a sandbox, `
    + 'days at a time, never for chat.',
};
// per role, on a mesh model: a reply's token cap, thinking, its effort and
// sampling; chimp's qwen's own for no thinking, the penalty against loops
const PROFILES = {
  chimp: {
    maxTokens: 4096, thinking: false, effort: 'low',
    sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 },
  },
  orangutan: { maxTokens: 32768, thinking: true, effort: 'high' },
};
// a model host's window when it names none, as container/model.js has it
const DEFAULT_CTX = 65536;
// idle, not total: a long prompt read on a cpu before the first token
const ASK_TIMEOUT_MS = 5 * 60 * 1000;
const GIB = 1024 ** 3;

// --- claims ----------------------------------------------------------------

// the last ask's share of the context window, by part, kept on the model
// host for the llama-server that answered it
let use = null;

// the daemon's own, only while still refreshed, the last ask's use
// carried while the server that answered it still runs
function state() {
  const claim = readFresh(CLAIM_FILE, CLAIM_MAX_AGE_MS);
  const live = claim && use && claim.runs && claim.serverSince === use.since;
  return live ? { ...claim, use } : claim;
}

// ours and every answering peer's
const view = () => [state(), ...mesh.peerModel()].filter((s) => s && NAME_RE.test(s.host || ''));

// every host with [model] host = true, by name
const runners = (states) => states.filter((s) => s.runs).sort((a, b) => a.host.localeCompare(b.host));
const n = (v) => Number(v) || 0;

// --- roles ------------------------------------------------------------------

// '' for none, the mesh's own models as phosphorus/<host>
const validChoice = (c) => !!c && (c.model === '' || MODEL_RE.test(c.model || '')) && Number.isFinite(c.at) && c.at <= Date.now() + 60000;
const pickOf = (x, r) => (x && validChoice(x[r]) ? x[r] : null);
const saved = readJson(ROLES_FILE, null) || {};
const chosen = Object.fromEntries(ROLES.map((r) => [r, pickOf(saved, r) || { model: '', at: 0 }]));
const meshHost = (model) => (model.startsWith(`${MESH}/`) ? model.slice(MESH.length + 1) : '');

// ours, each role's newer choice on a peer adopted and kept
function roles() {
  let changed = false;
  for (const r of ROLES) {
    const newer = mesh.peerModelRoles().map((x) => pickOf(x, r)).filter(Boolean).sort((a, b) => b.at - a.at)[0];
    if (newer && newer.at > chosen[r].at) { chosen[r] = { model: newer.model, at: newer.at }; changed = true; }
  }
  if (changed) writeJsonAtomic(ROLES_FILE, chosen);
  pullKeys();
  return chosen;
}

// a model as the chimp or the orangutan, mesh-wide: provider/model, or '' for none
function choose(p) {
  if (!ROLES.includes(p.role)) return [400, { error: `role is ${ROLES.join(' or ')}` }];
  const model = String(p.model || '').trim();
  if (model && !MODEL_RE.test(model)) return [400, { error: 'model is provider/model, as anthropic/claude-sonnet-5-5' }];
  if (meshHost(model) && !runners(view()).some((s) => s.host === meshHost(model))) return [409, { error: `${meshHost(model)} runs no model` }];
  chosen[p.role] = { model, at: Math.max(Date.now(), chosen[p.role].at + 1) };
  writeJsonAtomic(ROLES_FILE, chosen);
  return [200, chosen[p.role]];
}

// the role's mesh model while loaded, else the loaded one nearest its size
// (smallest for the chimp, biggest for the rest), else the role's own
function pick(states, role) {
  const all = runners(states);
  const want = all.find((s) => s.host === meshHost(roles()[role].model));
  if (want && want.server === 'ready') return want;
  const up = all.filter((s) => s.server === 'ready').sort((a, b) => n(a.size) - n(b.size));
  return (role === 'chimp' ? up[0] : up.at(-1)) || want || [...all].sort((a, b) => n(a.size) - n(b.size))[0] || null;
}

// the model a role answers with: its own when off the mesh, else a mesh host's
function resolve(states, role) {
  const own = roles()[role].model;
  if (own && !meshHost(own)) return { model: own, s: null };
  const s = pick(states, role);
  return { model: s ? `${MESH}/${s.host}` : '', s };
}

// --- api keys -----------------------------------------------------------------
// each provider's key and when set, '' once cleared, the latest on the mesh
// winning; peers fetch them over the tailnet, browsers only see which are set

const validKey = ([p, k]) => PROVIDER_RE.test(p) && p !== MESH && !!k && typeof k.key === 'string'
  && k.key.length <= 512 && Number.isFinite(k.at) && k.at <= Date.now() + 60000;
const keys = Object.fromEntries(Object.entries(readJson(KEYS_FILE, null) || {}).filter(validKey));
const keyStamps = () => Object.fromEntries(Object.entries(keys).map(([p, k]) => [p, k.at]));
const keyList = () => Object.keys(keys).filter((p) => keys[p].key).sort();
const stamp = (p) => (keys[p] && keys[p].at) || 0;

function merge(got) {
  let changed = false;
  for (const [p, k] of Object.entries(got && typeof got === 'object' ? got : {}).filter(validKey)) {
    if (k.at > stamp(p)) { keys[p] = { key: k.key, at: k.at }; changed = true; }
  }
  if (changed) writeJsonAtomic(KEYS_FILE, keys);
}

// a peer stamping a newer key: its keys fetched, one pull at a time, an
// ask waiting on the pull running
let pulling = null;
function pullKeys() {
  if (pulling) return pulling;
  const newer = mesh.peerModelKeys().filter(({ stamps }) => Object.entries(stamps)
    .some(([p, at]) => PROVIDER_RE.test(p) && Number(at) > stamp(p)));
  if (!newer.length) return Promise.resolve();
  pulling = (async () => {
    const ips = mesh.peerIps();
    for (const { host } of newer) {
      const ip = ips.get(host);
      const r = ip && await requestJson({ host: ip, port: FRONTEND_PORT, path: '/api/model/keys', timeout: 5000 }).catch(() => null);
      if (r && r.status === 200) merge(r.body);
    }
  })().finally(() => { pulling = null; });
  return pulling;
}

// a provider's key set from a browser, '' clearing it
function setKey(p) {
  const provider = String(p.provider || '').trim().toLowerCase();
  const key = String(p.key || '').trim();
  if (!PROVIDER_RE.test(provider) || provider === MESH) return [400, { error: 'provider is its id as models.dev has it, as anthropic' }];
  if (key.length > 512 || /\s/.test(key)) return [400, { error: 'bad key' }];
  keys[provider] = { key, at: Math.max(Date.now(), stamp(provider) + 1) };
  writeJsonAtomic(KEYS_FILE, keys);
  return [200, { provider, set: !!key }];
}

// what opencode starts with: the mesh's models and the keys set
const setup = (states) => ({
  mesh: runners(states).map((s) => ({ host: s.host, ctx: n(s.ctx) || DEFAULT_CTX })),
  keys: Object.fromEntries(keyList().map((p) => [p, keys[p].key])),
});

// every provider opencode knows, the models of those it can use
const catalog = () => harness.catalog(setup(view()));

// the last ask's parts, numbers only whatever a peer sent
const USE_KEYS = ['system', 'chat', 'ask', 'reply', 'tps', 'at'];
const useOf = (s) => (s && s.use && typeof s.use === 'object'
  ? Object.fromEntries(USE_KEYS.map((k) => [k, Math.max(0, Number(s.use[k]) || 0)])) : null);

// one model host's row, for the status tab and the cli's model tab
function row(s, states) {
  const ready = s.server === 'ready';
  const dl = s.download && typeof s.download === 'object' ? s.download : null;
  return {
    host: s.host, file: String(s.file || ''), size: n(s.size),
    ctx: n(s.ctx), slots: n(s.slots), ready, loading: s.server === 'loading',
    gpu: !!s.gpu, vram: n(s.vram), total: n(s.total), machine: n(s.machine), need: n(s.need),
    why: ready ? '' : excuse(states, s),
    use: ready ? useOf(s) : null,
    download: dl ? { done: n(dl.done), total: n(dl.total) } : null,
  };
}

// every model on the mesh, each role's choice, what it answers with and why
// not, its mesh host by name, and the providers with a key
function summary() {
  const states = view();
  const out = { handle: HANDLE, roles: {}, models: runners(states).map((s) => row(s, states)), keys: keyList() };
  for (const r of ROLES) {
    const { model, s } = resolve(states, r);
    const ready = !!model && (!s || s.server === 'ready');
    out.roles[r] = { chosen: roles()[r].model, model, host: s ? s.host : '', ready, why: ready ? '' : excuse(states, s) };
    out[r] = s ? s.host : '';
  }
  return out;
}

// why a model doesn't answer, in its own voice, a crash loop and a slow load
// told apart
function excuse(states, s) {
  if (!states.length) return 'not loaded: no host is running the model daemon';
  if (!s) return 'not loaded: no host has host = true under [model] in its phosphorus.ini';
  if (s.why) return `not loaded: ${s.why}`;
  if (s.oom && s.server !== 'ready') return 'out of vram, lower ctx or slots';
  const times = (k) => `${k} time${k === 1 ? '' : 's'}`;
  // shown whatever the server is doing, since a crash loop is mostly retries
  const crashed = s.exits
    ? `llama-server has exited ${times(s.exits)} since it was last up (${s.lastExit}), docker logs phosphorus on ${s.host} says why`
    : '';
  if (crashed && s.server !== 'loading') return `not loaded: ${crashed}`;
  if (s.server === 'loading') {
    const mins = s.serverSince ? Math.floor((Date.now() - s.serverSince) / 60000) : 0;
    return `still loading ${s.file} on ${s.host}, ${mins}m in${crashed ? `; ${crashed}` : ''}`;
  }
  if (s.download) {
    const pct = s.download.total ? ` ${Math.floor((100 * s.download.done) / s.download.total)}%` : '';
    return `not loaded: ${s.host} is still downloading ${s.file}${pct} (${(s.download.done / GIB).toFixed(1)}GB so far)`;
  }
  return `not loaded: starting llama-server on ${s.host}`;
}

// --- asking ----------------------------------------------------------------

// tokens in text, by llama-server's own tokenizer, 0 if it won't say
async function tokens(content) {
  const r = await requestJson({
    host: '127.0.0.1', port: SERVER_PORT, method: 'POST', path: '/tokenize', body: { content }, timeout: 5000,
  }).catch(() => null);
  return r && r.status === 200 && r.body && Array.isArray(r.body.tokens) ? r.body.tokens.length : 0;
}

// the ask's date, mesh and open file, ahead of its text so the system prompt
// never changes; counted with the system prompt
const withContext = (note, text) => `<context>\n${note}\n</context>\n\n${text}`;
const CONTEXT_BLOCK = /<context>\n[\s\S]*?\n<\/context>\n\n/;
// a turn's text, whether a string or an array of parts
const textOf = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('') : '');

// the system turns and tool schemas as the chat template renders them, up to
// a user turn's text, kept while they stay the same
const SENTINEL = '\u0000ask\u0000';
let framed = { key: '', n: 0 };
async function frameTokens(systems, tools) {
  const key = JSON.stringify([systems, tools || []]);
  if (framed.key === key) return framed.n;
  const r = await requestJson({
    host: '127.0.0.1', port: SERVER_PORT, method: 'POST', path: '/apply-template', timeout: 5000,
    body: { messages: [...systems, { role: 'user', content: SENTINEL }], add_generation_prompt: false, ...(tools && tools.length ? { tools } : {}) },
  }).catch(() => null);
  const at = r && r.status === 200 && r.body && typeof r.body.prompt === 'string' ? r.body.prompt.indexOf(SENTINEL) : -1;
  // a template that won't render it: the system text alone
  const n = await tokens(at > 0 ? r.body.prompt.slice(0, at) : systems.map((m) => textOf(m.content)).join('\n'));
  framed = { key, n };
  return n;
}

// the prompt split into the system prompt (tools and the ask's context with
// it), the ask and the chat between, tps: generation's own rate
async function measure(messages, tools, usage, genMs) {
  const prompt = Number(usage && usage.prompt_tokens) || 0;
  const claim = state();
  if (!prompt || !claim || !Array.isArray(messages)) return;
  const reply = Number(usage.completion_tokens) || 0;
  const systems = messages.slice(0, Math.max(0, messages.findIndex((m) => m.role !== 'system')));
  // the asker's own turn: the one carrying the context block
  const last = messages.findLast((m) => m.role === 'user' && CONTEXT_BLOCK.test(textOf(m.content)));
  const text = last ? textOf(last.content) : '';
  const context = text.match(CONTEXT_BLOCK);
  const [frame, note, said] = await Promise.all([
    systems.length ? frameTokens(systems, tools) : 0,
    context ? tokens(context[0]) : 0,
    context ? tokens(text.slice(context.index + context[0].length)) : 0,
  ]);
  const system = Math.min(prompt, frame + note);
  const ask = Math.min(prompt - system, said);
  use = {
    since: claim.serverSince || 0, at: Date.now(), system, ask, chat: Math.max(0, prompt - system - ask), reply,
    tps: genMs > 0 && reply > 1 ? Math.round(((reply - 1) * 1000) / genMs) : (use && use.tps) || 0,
  };
}

// opencode's call with its role's cap, thinking and sampling
const profiled = (p, role) => {
  const f = PROFILES[role];
  if (!f) return p;
  return {
    ...p, ...f.sampling, max_tokens: Math.min(Number(p.max_tokens) || f.maxTokens, f.maxTokens),
    chat_template_kwargs: { ...p.chat_template_kwargs, enable_thinking: f.thinking, reasoning_effort: f.effort },
  };
};
// usage asked for at the end of a stream
const completion = (p) => (p.stream ? { ...p, stream_options: { ...p.stream_options, include_usage: true } } : p);

// llama-server's or a peer's answer passed through whole, status included, so
// opencode reads its errors itself; resolves with usage and generation's ms
function forward({ host, port, path: p, body, headers }, who, res) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const up = http.request({
      host, port, path: p, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
    }, (ur) => {
      res.writeHead(ur.statusCode, { 'content-type': ur.headers['content-type'] || 'application/json', 'cache-control': 'no-cache' });
      const sse = /event-stream/.test(ur.headers['content-type'] || '');
      let buf = '';
      let usage = null;
      let first = 0;
      ur.on('data', (c) => {
        first ||= performance.now();
        res.write(c);
        buf += c.toString('utf8');
        if (!sse) return;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const d = line.startsWith('data: ') ? line.slice(6).trim() : '';
          if (!d || d === '[DONE]') continue;
          try { const ev = JSON.parse(d); if (ev.usage) usage = ev.usage; } catch {}
        }
      });
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        res.end();
        if (!sse) { try { usage = JSON.parse(buf).usage || null; } catch {} }
        resolve({ ok: ur.statusCode === 200, usage, genMs: sse && first ? performance.now() - first : 0 });
      };
      ur.on('end', end);
      ur.on('aborted', end);
      ur.on('error', end);
    });
    // the asker gone, the slot freed
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    up.setTimeout(ASK_TIMEOUT_MS, () => up.destroy(new Error('timed out')));
    up.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `${who} didn't answer: ${e.message}` } }));
      } else res.end();
      resolve({ ok: false });
    });
    up.end(data);
  });
}

// opencode's calls to a mesh model, its model the host running it: answered
// by llama-server here, else passed on to that host; local: from opencode
// itself, its session (ask) naming the role whose profile it takes
async function serveChat(p, res, local, ask) {
  const fail = (status, message) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message } })); };
  if (!p || !Array.isArray(p.messages)) { fail(400, 'bad messages'); return; }
  if (local && ask) p = profiled(p, ((await harness.context(ask)) || {}).role);
  const host = String(p.model || '');
  const states = view();
  const s = runners(states).find((x) => x.host === host);
  if (!s || s.server !== 'ready') { fail(503, excuse(states, s)); return; }
  if (host !== SELF_HOST) {
    // a peer's call for a model elsewhere never passed on again
    if (!local) { fail(409, `${host} isn't this host`); return; }
    await forward({ host: s.ip, port: FRONTEND_PORT, path: '/api/model/v1/chat/completions', body: p }, host, res);
    return;
  }
  const out = await forward({ host: '127.0.0.1', port: SERVER_PORT, path: '/v1/chat/completions', body: completion(p) }, `llama-server on ${host}`, res);
  if (out.ok) measure(p.messages, p.tools, out.usage, out.genMs).catch(() => {});
}

// no emoji ever reaching the chat, whatever a model writes
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3]/gu;
// ©, ® and ™ pictographic too, but text
const plain = (t) => t.replace(EMOJI, (c) => ('\u00A9\u00AE\u2122'.includes(c) ? c : ''));

// the roles chat asks, the orangutan on projects alone
const CHAT_ROLES = ['chimp'];

// {text, by}: the role's model asked through opencode, emoji stripped, cut short by signal
async function ask(messages, { role = 'chimp', asker, direct, signal } = {}) {
  const r = CHAT_ROLES.includes(role) ? role : 'chimp';
  // a key set elsewhere a moment ago already here
  await pullKeys();
  const states = view();
  const { model, s } = resolve(states, r);
  if (!model || (s && s.server !== 'ready')) throw new Error(excuse(states, s));
  // the role's identity first, as the system prompt's opening
  const [system, ...rest] = messages;
  const cast = [{ ...system, content: `${IDENTITY[r]}\n\n${system.content}` }, ...rest];
  const text = await harness.ask(cast, { model, role: r, asker, direct, signal, setup: setup(states) });
  return { text: plain(text).trim(), by: r };
}

// the orangutan's model for a project round, its identity and opencode's setup;
// a mesh host chosen, or the one the project ran on (prefer), waited for rather
// than swapped for another loaded model, thrown as why not while it's away
async function projectModel(prefer = '') {
  await pullKeys();
  const states = view();
  const own = roles().orangutan.model;
  const host = meshHost(own) || (!own && meshHost(prefer));
  if (host) {
    const s = runners(states).find((x) => x.host === host);
    if (!s || s.server !== 'ready') throw Object.assign(new Error(s ? excuse(states, s) : `${host} is offline`), { waiting: true });
    return { model: `${MESH}/${host}`, identity: IDENTITY.orangutan, setup: setup(states) };
  }
  const { model, s } = resolve(states, 'orangutan');
  if (!model || (s && s.server !== 'ready')) throw Object.assign(new Error(excuse(states, s)), { waiting: true });
  return { model, identity: IDENTITY.orangutan, setup: setup(states) };
}

// the role's llama-server slots not mid-answer erased, its kv cache started over,
// asked of the peer that runs it
async function purge(role) {
  const r = ROLES.includes(role) ? role : 'chimp';
  const { s } = resolve(view(), r);
  if (!s) throw new Error(`the ${r} isn't a mesh model, nothing here to purge`);
  if (s.server !== 'ready') throw new Error(`no ${r} loaded`);
  if (s.host === SELF_HOST) return eraseSlots();
  const res = await requestJson({ host: s.ip, port: FRONTEND_PORT, method: 'POST', path: '/api/model/purge', timeout: 10000 });
  if (res.status !== 200 || !res.body) throw new Error((res.body && res.body.error) || `${s.host} would not purge`);
  return res.body;
}
async function eraseSlots() {
  const local = (p, method = 'GET') => requestJson({ host: '127.0.0.1', port: SERVER_PORT, method, path: p, timeout: 5000, ...(method === 'POST' ? { body: {} } : {}) });
  const r = await local('/slots');
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('llama-server would not list its slots');
  const idle = r.body.filter((x) => !x.is_processing);
  const done = await Promise.all(idle.map((x) => local(`/slots/${x.id}?action=erase`, 'POST').then((e) => e.status === 200, () => false)));
  // the window's grid emptied with its slots, unless one is mid-answer
  if (idle.length === r.body.length) use = null;
  return { host: SELF_HOST, erased: done.filter(Boolean).length, busy: r.body.length - idle.length };
}

module.exports = {
  HANDLE, ROLES, state, roles, choose, summary, ask, projectModel, purge, eraseSlots, serveChat, withContext,
  keyStamps, setKey, keys: () => keys, catalog,
};
