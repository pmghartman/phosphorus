// transfer
import { jsonPost } from '../../lib/api.ts';
import { filesApi, filesCall, filesJoin, type Loc } from './api.ts';

// sent in chunks, each its own XHR, so no request nears a proxy's body cap or
// a phone holds one huge one open, a failed chunk retried alone
export const CHUNK = 4 * 1024 * 1024;

export async function putFile(loc: Loc, path: string, body: Blob, onSent?: (sent: number) => void): Promise<Record<string, any>> {
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

export function putChunk(loc: Loc, params: Record<string, string | number>, piece: Blob, onSent: (sent: number) => void): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', filesApi(loc, 'upload', params));
    xhr.timeout = 120000;
    xhr.upload.addEventListener('progress', (e) => onSent(e.loaded));
    xhr.addEventListener('load', () => {
      let body: Record<string, any> = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200) { resolve(body); return; }
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

// streamed for a bar that moves on the read too, the body still in memory
// before the write, the cost of no host-to-host copy
export async function getFile(loc: Loc, path: string, onGot?: (got: number, size: number) => void): Promise<{ blob: Blob; size: number }> {
  const res = await fetch(filesApi(loc, 'download', { path }));
  if (!res.ok) throw new Error(`couldn't read ${path}`);
  const size = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body) return { blob: await res.blob(), size };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onGot && onGot(got, size);
  }
  return { blob: new Blob(chunks as BlobPart[]), size: got };
}

// no server-side copy between hosts: each file pulled from one share by the
// browser and pushed to the other, the read the first half of the bar
export async function copyFile(from: Loc, fromPath: string, to: Loc, toPath: string, tick: (f: number) => void): Promise<void> {
  const { blob } = await getFile(from, fromPath, (got, size) => tick(size ? (got / size) * 0.5 : 0));
  await putFile(to, toPath, blob, (sent) => tick(0.5 + (blob.size ? (sent / blob.size) * 0.5 : 0.5)));
}

export async function copyTree(from: Loc, fromPath: string, to: Loc, toPath: string, tick: (f: number, name?: string) => void): Promise<void> {
  const listing = await filesCall(from, 'list', undefined, { path: fromPath });
  // already there: fine, anything else surfacing on the first child write
  await filesCall(to, 'mkdir', jsonPost({ path: toPath })).catch(() => {});
  for (const e of listing.entries) {
    const src = filesJoin(fromPath, e.name);
    const dst = filesJoin(toPath, e.name);
    if (e.dir) await copyTree(from, src, to, dst, tick);
    else await copyFile(from, src, to, dst, (f) => tick(f, e.name));
  }
}
