// composer

import type { CodeSession } from '@phosphorus/wire';
import { el } from '../../lib/dom.ts';
import { paintList, rec } from './list.ts';
import { paintHead, say } from './session.ts';
import { base, call, GL, live, qs, sapi, svg, type Transcript, UP_MAX } from './state.ts';

export function makeComposer(t: Transcript) {
  const node = el('div', 'cd-compose');
  const atts = el('div', 'cd-atts');
  const form = el('form', 'chat-form cd-form');
  const text = Object.assign(el('textarea', 'cd-text-in'), {
    rows: 1,
    placeholder: 'message',
    title: 'enter sends, shift+enter a new line, esc stops a turn',
    spellcheck: false,
  });
  const attach = Object.assign(el('button', 'chat-icon chat-attach cd-attach'), {
    type: 'button',
    ariaLabel: 'attach',
  });
  attach.innerHTML = svg(GL.attach!);
  const stop = Object.assign(el('button', 'cd-stop'), { type: 'button', title: 'stop this turn', ariaLabel: 'stop' });
  stop.innerHTML = `${svg(GL.stop!)}<span>stop</span>`;
  const go = Object.assign(el('button', 'chat-go'), {
    type: 'submit',
    title: 'send (enter)',
    ariaLabel: 'send',
    disabled: true,
  });
  go.innerHTML = svg(GL.send!);
  const input = Object.assign(el('input'), { type: 'file', multiple: true, hidden: true });
  form.append(el('span', 'chat-prompt', '>'), text, attach, stop, go);
  const foot = el('div', 'cd-compose-foot');
  foot.append(el('span', 'cd-msg'));
  node.append(atts, form, foot, input);
  const grow = () => {
    text.style.height = 'auto';
    text.style.height = `${Math.min(text.scrollHeight, 200)}px`;
    go.disabled = !text.value.trim();
  };
  text.addEventListener('input', grow);
  text.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
    if (e.key === 'Escape' && live(rec(t.id))) {
      e.preventDefault();
      stop.click();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = text.value.trim();
    if (!v) return;
    go.disabled = true;
    call(sapi(t.id, 'send'), 'POST', { text: v }).then(
      () => {
        text.value = '';
        grow();
        const r = rec(t.id);
        if (r && !live(r)) {
          r.status = 'working';
          paintHead();
          paintList();
        }
      },
      (err) => {
        say(err.message);
        go.disabled = false;
      },
    );
  });
  stop.addEventListener('click', () =>
    call(sapi(t.id, 'stop'), 'POST', {}).then(
      () => say('stopping'),
      (e) => say(e.message),
    ),
  );
  attach.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    upload(t, [...input.files!], atts, text, grow);
    input.value = '';
  });
  form.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  form.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    upload(t, [...e.dataTransfer.files], atts, text, grow);
  });
  text.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      upload(t, files, atts, text, grow);
    }
  });
  const state = (r: CodeSession | null) => {
    const working = !!live(r);
    stop.hidden = !working;
    attach.disabled = !r;
    attach.title = r ? `attach files: uploaded into ${r.host}:${r.dir}` : 'attach files';
    form.classList.toggle('cd-busy', working);
  };
  state(rec(t.id));
  return { node, text, state };
}

// a file posted raw, its progress told
export function sendFile(url: string, f: File, progress: (n: number) => void): Promise<Record<string, any>> {
  return new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => progress(e.loaded);
    x.onload = () => {
      let o: Record<string, any> = {};
      try {
        o = JSON.parse(x.responseText);
      } catch {}
      if (x.status >= 200 && x.status < 300) ok(o);
      else bad(new Error(o.error || `status ${x.status}`));
    };
    x.onerror = () => bad(new Error('upload failed'));
    x.send(f);
  });
}

// files sent into the session's folder over the user's login there, an
// existing name never overwritten (the server picks "name (1).ext"), then
// @mentioned in the prompt
export async function upload(
  t: Transcript,
  files: File[],
  atts: HTMLElement,
  text: HTMLTextAreaElement,
  grow: () => void,
) {
  const r = rec(t.id);
  if (!r) return;
  for (const f of files) {
    const chip = el('span', 'cd-att');
    const st = el('span', 'cd-att-st', '0%');
    chip.append(el('span', '', f.name || 'pasted'), st);
    atts.append(chip);
    try {
      if (f.size > UP_MAX) throw new Error('50MB at most');
      const o = await sendFile(
        `/api/code/upload?${qs({ host: r.host, dir: r.dir, name: f.name || 'pasted' })}`,
        f,
        (n) => {
          st.textContent = `${Math.round((n / (f.size || 1)) * 100)}%`;
        },
      );
      chip.remove();
      const name = base(o.path);
      const at = /\s/.test(name) ? `@"${name}"` : `@${name}`;
      text.value = `${text.value}${text.value && !/\s$/.test(text.value) ? ' ' : ''}${at} `;
      grow();
      text.focus();
    } catch (e) {
      chip.classList.add('bad');
      st.textContent = (e as Error).message;
      setTimeout(() => chip.remove(), 6000);
    }
  }
}
