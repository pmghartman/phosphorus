// claude's stream-json, one event at a time
import { el } from '../../lib/dom.ts';
import { renderMd } from '../../lib/md.ts';
import { go, rec } from './list.ts';
import { paintNew } from './newsession.ts';
import { addNote } from './session.ts';
import { ANTH, cd, kfmt, provOf, tilde, type Live, type Transcript, type Why } from './state.ts';
import { toolCard, toolResult } from './tools.ts';

export function claudeEv(t: Transcript, ev: Record<string, any>) {
  const where = ev.parent_tool_use_id ? t.cards.get(ev.parent_tool_use_id)?.sub || t.node : t.node;
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        const bits = [ev.model, ev.permissionMode, ev.cwd && tilde(ev.cwd)].filter(Boolean);
        addNote(t, 'session', bits.join(' · ') || 'started').classList.add('cd-quiet');
      } else if (ev.subtype === 'api_retry') retryNote(t, ev);
      else if (ev.subtype && ev.subtype !== 'status') addNote(t, ev.subtype.replace(/_/g, ' '), ev.message || ev.content || '').classList.add('cd-quiet');
      break;
    case 'stream_event': if (!ev.parent_tool_use_id) streamEv(t, ev.event || {}); break;
    case 'assistant': {
      const content = ev.message?.content || [];
      for (const b of content) {
        if (b.type === 'text') { if (b.text?.trim()) place(t, 'text', textBlock(b.text), where); }
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') place(t, 'thinking', thinkBlock(b.thinking || '(redacted)'), where);
        else if (b.type === 'tool_use') place(t, 'tool', toolCard(t, b), where);
      }
      if (ev.error) addNote(t, 'error', String(ev.error));
      break;
    }
    case 'user': {
      const content = ev.message?.content;
      if (!Array.isArray(content)) break;
      for (const b of content) if (b.type === 'tool_result') toolResult(t, b);
      break;
    }
    case 'result': {
      flushLive(t);
      const u = ev.usage || {};
      const tin = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const bad = ev.is_error || (ev.subtype && ev.subtype !== 'success');
      const bits = [bad ? (ev.subtype || 'error').replace(/_/g, ' ') : 'done'];
      if (ev.num_turns) bits.push(`${ev.num_turns} turn${ev.num_turns === 1 ? '' : 's'}`);
      if (ev.duration_ms) bits.push(`${(ev.duration_ms / 1000).toFixed(1)}s`);
      if (tin || u.output_tokens) bits.push(`↑${kfmt(tin)} ↓${kfmt(u.output_tokens)}`);
      const billed = Object.keys(ev.modelUsage || {}).some((k) => ANTH.includes(k) || k.startsWith('claude-'));
      if (ev.total_cost_usd && billed) bits.push(`$${ev.total_cost_usd.toFixed(4)}`);
      const f = el('div', `cd-foot${bad ? ' bad' : ''}`);
      f.append(el('span', '', bits.join(' · ')));
      t.node.append(f);
      if (bad && ev.result && typeof ev.result === 'string') addNote(t, 'error', ev.result);
      if (bad && Array.isArray(ev.errors)) {
        for (const e of ev.errors) {
          // claude's own diagnostic when no answer ever came: the last retry's reason in its place
          if (/^\[ede_diagnostic\]/.test(String(e))) noAnswer(t, String(e));
          else addNote(t, 'error', String(e));
        }
      }
      t.apiWhy = null;
      t.retryEl = null;
      break;
    }
    default: break;
  }
}

// why an api call failed, by its status, in words that say where to look
export function apiWhy(t: Transcript, status: number | undefined, kind: string | undefined): Why {
  const anth = provOf(rec(t.id)?.model) === 'anthropic';
  const who = anth ? 'Anthropic' : "the mesh's model gateway";
  if (!status) return { text: `couldn't reach ${who}${anth ? '' : ` from ${rec(t.id)?.host || 'the host'}`}`, auth: false };
  if (status === 401 || status === 403 || kind === 'authentication_failed') {
    return { text: anth ? 'Anthropic refused the token: sign in to Claude again' : 'the model gateway refused your phosphorus key', auth: anth };
  }
  if (status === 429) return { text: `${who} is rate limiting (429)`, auth: false };
  if (status === 529 || status === 503) return { text: anth ? 'Anthropic is overloaded (529)' : `the model isn't loaded or is busy (${status}): check models in status`, auth: false };
  if (status === 404) return { text: `${who} has no such model (404)`, auth: false };
  return { text: `${who} failed (${status}${kind && kind !== 'unknown' ? ` ${kind.replace(/_/g, ' ')}` : ''})`, auth: false };
}

// claude retrying a failed call: one line, kept current while nothing else lands
export function retryNote(t: Transcript, ev: Record<string, any>) {
  const why = apiWhy(t, ev.error_status, ev.error);
  t.apiWhy = why;
  const text = `${why.text} · try ${ev.attempt || '?'} of ${ev.max_retries || '?'}`;
  if (t.retryEl && t.node.lastElementChild === t.retryEl) t.retryEl.querySelector('.cd-note-text')!.textContent = text;
  else { t.retryEl = addNote(t, 'retrying', text); t.retryEl.classList.add('cd-note-warn'); }
}

export function noAnswer(t: Transcript, raw: string) {
  const why = t.apiWhy;
  const n = addNote(t, 'error', `no answer from the model${why ? `: ${why.text}` : ''}`);
  n.title = raw;
  if (why?.auth) {
    const b = Object.assign(el('button', 'cd-mini primary', 'sign in to Claude'), { type: 'button' });
    b.addEventListener('click', () => { cd.login = true; if (cd.pick === 'new') paintNew(); else go('new'); });
    n.append(b);
  }
}

// a final block in place of its streamed draft, else at the end
export function place(t: Transcript, kind: string, node: HTMLElement, where: HTMLElement) {
  const i = where === t.node ? t.live.findIndex((x) => x.kind === kind) : -1;
  if (i >= 0) {
    const [x] = t.live.splice(i, 1);
    x!.el.replaceWith(node);
  } else where.append(node);
}

export function flushLive(t: Transcript) {
  for (const x of t.live) x.el.remove();
  t.live = [];
}

export function streamEv(t: Transcript, e: Record<string, any>) {
  if (e.type === 'content_block_start') {
    const kind = ({ text: 'text', thinking: 'thinking', tool_use: 'tool', server_tool_use: 'tool' } as Record<string, string>)[e.content_block?.type];
    if (!kind) return;
    let node: HTMLElement;
    if (kind === 'text') node = el('div', 'cd-text cd-streaming');
    else if (kind === 'thinking') node = thinkBlock('');
    else {
      node = el('div', 'cd-tool run cd-streaming');
      const h = el('div', 'cd-tool-head');
      h.append(el('span', 'cd-pip'), el('span', 'cd-tool-name', e.content_block.name || 'tool'), el('span', 'cd-tool-arg', '…'));
      node.append(h);
    }
    const x: Live = { kind, el: node, index: e.index, text: '' };
    t.live.push(x);
    t.node.append(node);
  } else if (e.type === 'content_block_delta') {
    const x = t.live.findLast((y) => y.index === e.index);
    if (!x) return;
    const d = e.delta || {};
    if (d.type === 'text_delta') {
      x.text += d.text || '';
      if (!x.timer) {
        x.timer = setTimeout(() => {
          x.timer = 0;
          if (!x.el.isConnected) return;
          const stick = t.node.scrollHeight - t.node.scrollTop - t.node.clientHeight < 40;
          // plain while it streams, the server's markdown only for the final block
          x.el.textContent = x.text;
          if (stick) t.node.scrollTop = t.node.scrollHeight;
        }, 120);
      }
    } else if (d.type === 'thinking_delta') {
      x.text += d.thinking || '';
      x.el.querySelector('.cd-think-body')!.textContent = x.text;
      x.el.querySelector('.cd-think-sum')!.textContent = 'thinking…';
    }
  } else if (e.type === 'message_stop') {
    // drafts never confirmed by a final block (none arrive for an interrupted turn) left till the turn ends
  }
}

export function textBlock(text: string): HTMLElement {
  const d = el('div', 'cd-text md');
  renderMd(d, text);
  return d;
}

export function thinkBlock(text: string): HTMLElement {
  const d = el('details', 'cd-think');
  const s = el('summary', 'cd-think-sum', text ? `thought · ${kfmt(text.length)} chars` : 'thinking…');
  d.append(s, el('div', 'cd-think-body', text));
  return d;
}
