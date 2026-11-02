import { sendPage } from '../../lib/sync.ts';
import { stHostsEl } from './state.ts';

// the model card's clear context: the host's llama-server slots erased, a
// fresh start for its kv cache; captured, so the card's own click never sees it
stHostsEl.addEventListener(
  'click',
  (e) => {
    const b = (e.target as Element).closest('.st-clear') as HTMLButtonElement | null;
    if (!b) return;
    e.stopPropagation();
    if (b.disabled || !sendPage({ type: 'model-purge', to: b.dataset.host })) return;
    b.disabled = true;
    b.textContent = 'clearing';
  },
  true,
);

export function modelPurged(msg: { id: string; error?: string }) {
  const btn = stHostsEl.querySelector(
    `.st-clear[data-host="${CSS.escape(String(msg.id))}"]`,
  ) as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = msg.error ? `no clear: ${msg.error}` : 'cleared';
  setTimeout(() => {
    btn.textContent = 'clear context';
  }, 2500);
}
