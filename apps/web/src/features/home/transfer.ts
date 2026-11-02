// transfer
import { filesApi, type Loc } from './api.ts';

// sent in chunks, each its own XHR, so no request nears a proxy's body cap or
// a phone holds one huge one open, a failed chunk retried alone
export const CHUNK = 4 * 1024 * 1024;

export async function putFile(
  loc: Loc,
  path: string,
  body: Blob,
  onSent?: (sent: number) => void,
): Promise<Record<string, any>> {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
  const total = body.size;
  let offset = 0;
  let last: Record<string, any> = {};
  do {
    const end = Math.min(offset + CHUNK, total);
    const piece = body.slice(offset, end);
    for (let tries = 1; ; tries++) {
      try {
        last = await putChunk(loc, { path, id, offset, total }, piece, (sent) => onSent && onSent(offset + sent));
        break;
      } catch (err) {
        if (tries >= 4 || (err as FatalError).fatal) throw err;
        await new Promise((r) => setTimeout(r, 1000 * tries));
      }
    }
    offset = end;
    if (onSent) onSent(offset);
  } while (offset < total);
  return last;
}

// a refusal the server means, retrying changes nothing
export type FatalError = Error & { fatal?: boolean };

export function putChunk(
  loc: Loc,
  params: Record<string, string | number>,
  piece: Blob,
  onSent: (sent: number) => void,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', filesApi(loc, 'upload', params));
    xhr.timeout = 120000;
    xhr.upload.addEventListener('progress', (e) => onSent(e.loaded));
    xhr.addEventListener('load', () => {
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 200) {
        resolve(body);
        return;
      }
      const err: FatalError = new Error(body.error || `status ${xhr.status}`);
      // a refusal the server means, retrying changes nothing
      err.fatal = xhr.status >= 400 && xhr.status < 500;
      reject(err);
    });
    xhr.addEventListener('error', () => reject(new Error('upload failed')));
    xhr.addEventListener('timeout', () => reject(new Error('upload timed out')));
    xhr.send(piece);
  });
}
