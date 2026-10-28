// --- keys and popups ------------------------------------------------------------
import { chatPanel, cwList, stepConv } from '../features/chat/chat.ts';
import { closeUpdateModal, updateModal } from '../features/update.ts';
import { modalOpen } from '../lib/dom.ts';
import { dkIconKeys } from './desk.ts';

// swipe down on a popup: dismissed, as by its ×
for (const box of document.querySelectorAll<HTMLElement>('.modal-box')) {
  let drag: { id: number; y: number; on: boolean } | null = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || (e.target as Element).closest('input, select, textarea, button')) return;
    drag = { id: e.pointerId, y: e.clientY, on: false };
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = Math.max(0, e.clientY - drag.y);
    if (!drag.on && dy > 8) {
      drag.on = true;
      box.setPointerCapture(e.pointerId);
      box.classList.add('dragging');
    }
    if (drag.on) box.style.transform = `translateY(${dy}px)`;
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const gone = drag.on && e.type === 'pointerup' && e.clientY - drag.y > 60;
    drag = null;
    box.classList.remove('dragging');
    box.classList.add('settling');
    box.addEventListener('transitionend', () => box.classList.remove('settling'), { once: true });
    box.style.transform = '';
    if (gone) (box.querySelector('.modal-close') as HTMLElement).click();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

// ctrl+↑↓ through the chats, from the chat or anywhere not typing; ahead of
// the chat box's own ↑, an editor's and a terminal's left alone
document.addEventListener(
  'keydown',
  (e) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const t = e.target as Element;
    const inChat = chatPanel.contains(t) || cwList.contains(t);
    if (modalOpen() || (!inChat && t.closest?.('input, textarea, select, [contenteditable], .xterm'))) return;
    e.preventDefault();
    e.stopPropagation();
    stepConv(e.key === 'ArrowDown' ? 1 : -1);
  },
  true,
);

// a press outside the update pane and its button closing it
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!updateModal.hidden && !updateModal.parentElement!.contains(e.target as Node)) closeUpdateModal();
  },
  true,
);

// shift+esc only ever unfocusing a terminal, esc the update pane
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.key !== 'Escape') return;
  const t = e.target as HTMLElement;
  if (e.shiftKey) {
    if (t.closest?.('.xterm')) t.blur();
    e.preventDefault();
    return;
  }
  if (t.closest?.('.chat-panel') && t.closest('input, textarea')) t.blur();
  if (!updateModal.hidden) closeUpdateModal();
});

// esc and ctrl+a for the desktop's icons, after the escape above
document.addEventListener('keydown', dkIconKeys);
