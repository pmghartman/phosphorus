// --- host logins: a host's user and password tried on its shell, the users last typed
import { wsBase } from '../lib/api.ts';
import { newSid } from '../lib/util.ts';

export const DK_USERS_KEY = 'phosphorus-dk-users';

export function dkUsers(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DK_USERS_KEY)!) || {};
  } catch {
    return {};
  }
}

// null once the host's shell answers, else why not, the session ended either way
export function dkProbe(host: string, user: string, pass: string): Promise<string | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `${wsBase()}/api/term/${encodeURIComponent(host)}?${new URLSearchParams({ sid: newSid(), since: '0' })}`,
    );
    ws.binaryType = 'arraybuffer';
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let text = '';
    let step = 0;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const lastLine = () => text.trim().split(/\r?\n/).filter(Boolean)[0];
    const done = (why: string | null) => {
      if (step === 3) return;
      step = 3;
      clearTimeout(settle!);
      clearTimeout(limit);
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close' }));
      ws.close();
      resolve(why);
    };
    const limit = setTimeout(() => done('no answer'), 15000);
    ws.onmessage = (e) => {
      text += dec.decode(e.data, { stream: true });
      if (step === 0 && /login: $/.test(text)) {
        step = 1;
        text = '';
        ws.send(enc.encode(`${user}\r`));
      } else if (step === 1 && /password: $/.test(text)) {
        step = 2;
        text = '';
        ws.send(enc.encode(`${pass}\r`));
      } else if (step === 2) {
        if (/login: $/.test(text)) return done(lastLine() || 'access denied');
        // the shell's first words, unless a refusal's prompt follows close behind
        if (text.trim()) {
          clearTimeout(settle!);
          settle = setTimeout(() => done(null), 250);
        }
      }
    };
    ws.onclose = () => done(lastLine() || `${host} didn't answer`);
  });
}
