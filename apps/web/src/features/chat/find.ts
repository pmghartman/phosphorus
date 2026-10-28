// find
import { chatFind, chatFindCount, chatFindInput, chatLog, chatText } from './state.ts';

export function findIn(li: HTMLElement) {
  const q = chatFindInput.value.trim().toLowerCase();
  if (!li.matches('.msg, .sys')) return;
  const t = li.textContent!.replace(li.querySelector('.msg-more')?.textContent || '', '');
  li.classList.toggle('miss', !!q && !t.toLowerCase().includes(q));
}

export function runFind() {
  const all = [...chatLog.querySelectorAll<HTMLElement>('li.msg, li.sys')];
  all.forEach(findIn);
  const q = chatFindInput.value.trim();
  chatFindCount.textContent = q ? `${all.filter((li) => !li.classList.contains('miss')).length} of ${all.length}` : '';
  chatLog.classList.toggle('finding', !!q);
  chatLog.scrollTop = chatLog.scrollHeight;
}

export function toggleFind(on = chatFind.hidden) {
  chatFind.hidden = !on;
  if (!on) { chatFindInput.value = ''; runFind(); chatText.focus(); return; }
  chatFindInput.focus();
  chatFindInput.select();
}

document.getElementById('chat-find-btn')!.addEventListener('click', () => toggleFind());
chatFindInput.addEventListener('input', runFind);
chatFindInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); toggleFind(false); }
});
