// tool calls: a line like a coding agent's log, its outcome under it, the detail folded
import { el } from '../../lib/dom.ts';
import { countDiff, diffView, lines } from './diffs.ts';
import { OUT_MAX, kfmt, type Todo, type Transcript } from './state.ts';
import { paintTodos, todoList } from './todos.ts';

export const COMPACT = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead', 'BashOutput', 'KillShell', 'KillBash']);

export function toolArg(name: string, x: Record<string, any> = {}): string {
  switch (name) {
    case 'Bash': return x.description || x.command || '';
    case 'Read': return `${x.file_path || ''}${x.offset ? ` :${x.offset}${x.limit ? `-${x.offset + x.limit}` : ''}` : ''}`;
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return x.file_path || x.notebook_path || '';
    case 'Glob': return `${x.pattern || ''}${x.path ? ` in ${x.path}` : ''}`;
    case 'Grep': return `${x.pattern || ''}${x.path ? ` in ${x.path}` : ''}${x.glob ? ` (${x.glob})` : ''}`;
    case 'WebFetch': return x.url || '';
    case 'WebSearch': return x.query || '';
    case 'Task': case 'Agent': return x.description || x.subagent_type || '';
    case 'TodoWrite': return `${(x.todos || []).filter((y: Todo) => y.status === 'completed').length}/${(x.todos || []).length} done`;
    default: {
      const v = Object.values(x).find((y) => typeof y === 'string') as string | undefined;
      return v ? v.slice(0, 120) : '';
    }
  }
}

// mcp__phosphorus__files_list as phosphorus · files_list
export const toolName = (n: string) => (n.startsWith('mcp__') ? n.slice(5).replace('__', ' · ') : n);

export function toolCard(t: Transcript, b: Record<string, any>): HTMLElement {
  const name: string = b.name || 'tool';
  const x = b.input || {};
  const c = el('div', `cd-tool run cd-tool-${name.replace(/[^\w-]/g, '_')}`);
  const h = Object.assign(el('button', 'cd-tool-head'), { type: 'button' });
  h.append(el('span', 'cd-pip'), el('span', 'cd-tool-name', toolName(name)));
  const arg = toolArg(name, x);
  if (arg) h.append(el('span', 'cd-tool-arg', arg));
  const stat = editStat(name, x);
  if (stat) h.append(stat);
  const out = el('div', 'cd-tool-out', 'running');
  const body = el('div', 'cd-tool-body');
  const sub = el('div', 'cd-tool-sub');
  // edits shown open as the desktop app does, the rest folded
  const open = ['Edit', 'MultiEdit', 'Write'].includes(name);
  body.hidden = !open;
  c.classList.toggle('open', open);
  h.addEventListener('click', () => { body.hidden = !body.hidden; c.classList.toggle('open', !body.hidden); });
  body.append(...toolInput(name, x));
  c.append(h, out, body, sub);
  if (name === 'Task' || name === 'Agent') sub.hidden = false; else sub.hidden = true;
  t.cards.set(b.id, { el: c, body, out, sub, name, input: x });
  if (name === 'TodoWrite') { t.todos = x.todos || []; paintTodos(t); }
  return c;
}

export function editStat(name: string, x: Record<string, any>): HTMLElement | null {
  let add = 0;
  let del = 0;
  if (name === 'Write') add = lines(x.content).length;
  else if (name === 'Edit') ({ add, del } = countDiff(x.old_string, x.new_string));
  else if (name === 'MultiEdit') for (const e of x.edits || []) { const n = countDiff(e.old_string, e.new_string); add += n.add; del += n.del; }
  else return null;
  const s = el('span', 'cd-tool-stat');
  s.append(el('span', 'cd-add', `+${add}`), ' ', el('span', 'cd-del', `−${del}`));
  return s;
}

export function toolInput(name: string, x: Record<string, any>): HTMLElement[] {
  switch (name) {
    case 'Bash': {
      const p = el('pre', 'cd-cmd');
      p.append(el('span', 'cd-prompt', '$ '), x.command || '');
      return [p];
    }
    case 'Edit': return [diffView(x.old_string, x.new_string)];
    case 'MultiEdit': return (x.edits || []).map((e: Record<string, string>) => diffView(e.old_string, e.new_string));
    case 'Write': return [diffView('', x.content)];
    case 'TodoWrite': return [todoList(x.todos || [])];
    default:
      if (COMPACT.has(name)) return [];
      return [Object.assign(el('pre', 'cd-json'), { textContent: JSON.stringify(x, null, 2) })];
  }
}

export const resultText = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : '')).join('\n') : c == null ? '' : JSON.stringify(c, null, 2));
export const clip = (s: string) => (s.length > OUT_MAX ? `${s.slice(0, OUT_MAX)}\n… ${kfmt(s.length - OUT_MAX)} more chars` : s);

export function toolResult(t: Transcript, b: Record<string, any>) {
  const c = t.cards.get(b.tool_use_id);
  if (!c) return;
  const text = resultText(b.content).replace(/\s+$/, '');
  const bad = !!b.is_error;
  c.el.classList.remove('run');
  c.el.classList.add(bad ? 'bad' : 'ok');
  const n = text ? text.split('\n').length : 0;
  let out;
  if (bad) out = text.split('\n')[0] || 'failed';
  else if (c.name === 'Bash') out = text ? `${text.split('\n')[0]!.slice(0, 160)}${n > 1 ? `  (+${n - 1} lines)` : ''}` : '(no output)';
  else if (c.name === 'Read') out = `${n} lines`;
  else if (c.name === 'Glob') out = /^no files/i.test(text) ? 'no files' : `${n} files`;
  else if (c.name === 'Grep') out = text.split('\n')[0]!.slice(0, 160) || 'no matches';
  else if (['Edit', 'MultiEdit', 'Write'].includes(c.name)) out = 'applied';
  else if (c.name === 'TodoWrite') out = 'todos updated';
  else out = text ? `${text.split('\n')[0]!.slice(0, 160)}${n > 1 ? `  (+${n - 1} lines)` : ''}` : 'done';
  c.out.textContent = out;
  // what came back, folded with the input, unless an edit's "updated" line
  if (text && (bad || !['Edit', 'MultiEdit', 'Write', 'TodoWrite'].includes(c.name))) {
    const p = el('pre', `cd-result${bad ? ' bad' : ''}`, clip(text));
    c.body.append(p);
  }
}
