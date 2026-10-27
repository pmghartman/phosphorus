import { jsonPost } from '../api.ts';
import { el } from '../dom.ts';
import { filesCall } from '../shares.ts';
import type { DkWin } from '../desktop/windows.ts';
import type { FileRef } from '../desktop/deskfiles.ts';

// --- editor: one file as plain text in a window, no tabs, no highlighting ----
// f: { host, share, path, label }; read and saved through the files API

function editorStart(w: DkWin, f: FileRef): { focus: () => void; holdClose: () => boolean } {
  const loc = { host: f.host, share: String(f.share ?? '') };
  const name = f.path.split('/').pop() || f.path;
  const bar = el('div', 'ed-bar');
  const where = el('span', 'ed-path', f.label || f.path);
  const note = el('span', 'ed-note', 'loading');
  const save = Object.assign(el('button', 'ed-save', 'save'), { type: 'button', disabled: true });
  bar.append(where, note, save);
  const ta = Object.assign(el('textarea', 'ed-ta'), { spellcheck: false, wrap: 'off', disabled: true });
  w.body.replaceChildren(bar, ta);

  let saved = '';
  let busy = false;
  const dirty = () => ta.value !== saved;
  const mark = () => {
    const t = dirty() ? `${name} •` : name;
    w.head.querySelector('.tab-label')!.textContent = t;
    w.task.querySelector('.dk-task-t')!.textContent = t;
    save.disabled = busy || !dirty();
  };
  const say = (t: string) => { note.textContent = t; };

  const put = async () => {
    if (busy || !dirty()) return true;
    busy = true;
    const text = ta.value;
    mark();
    say('saving');
    try {
      await filesCall(loc, 'save', jsonPost({ path: f.path, text }));
      saved = text;
      say('saved');
    } catch (err) {
      say((err as Error).message);
    }
    busy = false;
    mark();
    return !dirty();
  };

  filesCall(loc, 'read', undefined, { path: f.path }).then((r) => {
    if (r.binary || r.tooBig) { say(r.binary ? 'binary file' : 'too big to edit'); return; }
    saved = r.text!;
    ta.value = r.text!;
    ta.disabled = false;
    say('');
    mark();
    ta.focus();
  }, (err) => say(err.message));

  save.addEventListener('click', put);
  ta.addEventListener('input', () => { if (note.textContent === 'saved') say(''); mark(); });
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); put(); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });

  return {
    focus: () => { if (!ta.disabled) ta.focus(); },
    // unsaved text asked about first; done runs once it may close
    holdClose: () => {
      if (!dirty()) return false;
      if (confirm(`${name} has unsaved changes. Close without saving?`)) return false;
      return true;
    },
  };
}

export { editorStart };
