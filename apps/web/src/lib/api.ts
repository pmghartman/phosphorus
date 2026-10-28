// fetch and socket helpers: a JSON post's init, a bare post's failure, the account's calls,
// and the page's own socket base

export const wsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

export const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// a bare POST's failure as text, blank when it went through
export async function postFailure(url: string): Promise<string> {
  try {
    const res = await fetch(url, { method: 'POST' });
    if (res.ok) return '';
    const body = await res.json().catch(() => ({}));
    return body.error || `status ${res.status}`;
  } catch (err) {
    return (err as Error).message;
  }
}

// the answer to an account call: the status, and whatever the server said
export type Called<T = Record<string, any>> = { ok: boolean; status: number; error?: string } & Partial<T> &
  Record<string, any>;

// a GET without a body, a JSON POST with one; failures as a status of 0
export async function acctCall<T = Record<string, any>>(url: string, body?: unknown): Promise<Called<T>> {
  try {
    const r = await fetch(
      url,
      body === undefined
        ? {}
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const out = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...out };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message } as Called<T>;
  }
}
