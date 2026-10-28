// todos: TodoWrite's list pinned above the composer, a bar of how far
import { el } from '../../lib/dom.ts';
import { esc } from '../../lib/util.ts';
import { type Todo, type Transcript } from './state.ts';

export const cdBar = (frac: number, n = 20) => {
  const k = Math.max(0, Math.min(n, Math.round(frac * n)));
  return `[<span class="cd-cells">${'█'.repeat(k)}<i>${'░'.repeat(n - k)}</i></span>]`;
};

export function todoList(todos: Todo[]): HTMLElement {
  const ul = el('ul', 'cd-todo-list');
  for (const x of todos) {
    const li = el('li', `cd-todo-${x.status}`);
    li.append(
      el('span', 'cd-box', x.status === 'completed' ? '[x]' : x.status === 'in_progress' ? '[~]' : '[ ]'),
      ' ',
      x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content,
    );
    ul.append(li);
  }
  return ul;
}

export function paintTodos(t: Transcript) {
  const box = t.todoEl;
  if (!box) return;
  const todos = t.todos || [];
  box.hidden = !todos.length;
  if (!todos.length) return;
  const done = todos.filter((x) => x.status === 'completed').length;
  const now = todos.find((x) => x.status === 'in_progress');
  const h = Object.assign(el('button', 'cd-todo-head'), { type: 'button' });
  h.innerHTML =
    `<span class="cd-todo-t">todos</span> ${cdBar(done / todos.length)} <span class="st-dim">${done}/${todos.length}</span>` +
    (now ? ` <span class="cd-todo-now">${esc(now.activeForm || now.content)}</span>` : '');
  const list = todoList(todos);
  list.hidden = !!t.todoFold;
  h.addEventListener('click', () => {
    t.todoFold = !t.todoFold;
    list.hidden = t.todoFold;
  });
  box.replaceChildren(h, list);
}
