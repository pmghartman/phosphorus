// Installs inside the opaque extension frame. Files stay behind Sulfur's existing
// permission-checked port; no authenticated URL or cookie is exposed to an extension.
export function installExtensionResources(call) {
  const originalFetch = globalThis.fetch;
  const OriginalWorker = globalThis.Worker;
  const workers = new Set();
  let disposed = false;
  const virtual = (input) => /^(file:|sulfur-res:)/i.test(String(input?.url || input));
  const pathOf = (input) => decodeURIComponent(new URL(String(input?.url || input)).pathname);
  const types = { wasm: 'application/wasm', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', css: 'text/css', json: 'application/json',
    html: 'text/html', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', txt: 'text/plain' };
  const mime = (url) => types[url.split(/[?#]/)[0].split('.').pop().toLowerCase()] || 'application/octet-stream';
  const fetchResource = async (input, options = {}) => {
    if (!virtual(input)) return originalFetch.call(globalThis, input, options);
    const signal = options.signal || input?.signal;
    signal?.throwIfAborted();
    if (!['GET', 'HEAD'].includes(String(options.method || input?.method || 'GET').toUpperCase())) throw new TypeError('Extension resources are read-only');
    const bytes = await call('workspace.readBytes', pathOf(input));
    signal?.throwIfAborted();
    return new Response(String(options.method || input?.method || 'GET').toUpperCase() === 'HEAD' ? null : bytes, { headers: { 'Content-Type': mime(String(input?.url || input)) } });
  };
  globalThis.fetch = fetchResource;

  // A real Worker is returned immediately, preserving transfer lists and native
  // message ordering. Its bootstrap queues application messages while loading the
  // entry through the port, and proxies worker fetches (including wasm) the same way.
  function workerMain(entry, key, module) {
    // Blob workers in an opaque sandbox are not secure contexts. getRandomValues
    // remains available, so provide the same RFC 4122 v4 UUID format when needed.
    if (typeof crypto.randomUUID !== 'function') crypto.randomUUID = () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    const send = self.postMessage.bind(self), nativeFetch = self.fetch.bind(self);
    const pending = new Map(), queued = [];
    let seq = 0, ready = false;
    self.fetch = (input, options = {}) => {
      const url = String(input?.url || input);
      if (!/^(file:|sulfur-res:)/i.test(url)) return nativeFetch(input, options);
      const signal = options.signal || input?.signal;
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const abort = () => { pending.delete(id); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
        pending.set(id, { resolve, reject, signal, abort });
        signal?.addEventListener('abort', abort, { once: true });
        send({ sulfurResource: key, id, url, method: options.method || input?.method || 'GET' });
      });
    };
    self.addEventListener('message', (event) => {
      const m = event.data;
      if (m?.sulfurResource === key) {
        event.stopImmediatePropagation();
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        p.signal?.removeEventListener('abort', p.abort);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(new Response(m.bytes, { headers: { 'Content-Type': m.mime } }));
      } else if (!ready) { event.stopImmediatePropagation(); queued.push(event); }
    });
    (async () => {
      const source = await (await self.fetch(entry)).text();
      const url = URL.createObjectURL(new Blob([source, `\n//# sourceURL=${entry.replace(/[\r\n]/g, '')}`], { type: 'text/javascript' }));
      try { if (module) await import(url); else self.importScripts(url); }
      finally { URL.revokeObjectURL(url); }
      ready = true;
      for (const event of queued.splice(0)) self.dispatchEvent(new MessageEvent('message', {
        data: event.data, ports: event.ports, origin: event.origin, lastEventId: event.lastEventId,
      }));
    })().catch((error) => {
      send({ sulfurResource: key, error: String(error?.stack || error) });
      setTimeout(() => { throw error; });
    });
  }
  function ResourceWorker(source, options) {
    if (!new.target) throw new TypeError("Worker constructor requires 'new'");
    const entry = String(source);
    if (!virtual(entry)) return new OriginalWorker(source, options);
    const key = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const script = `(${workerMain.toString()})(${JSON.stringify(entry)},${JSON.stringify(key)},${options?.type === 'module'})`;
    const bootstrap = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
    let worker;
    try { worker = new OriginalWorker(bootstrap, options); }
    catch (error) { URL.revokeObjectURL(bootstrap); throw error; }
    workers.add(worker);
    let live = true;
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { live = false; workers.delete(worker); URL.revokeObjectURL(bootstrap); terminate(); };
    worker.addEventListener('message', async (event) => {
      const m = event.data;
      if (m?.sulfurResource !== key) return;
      event.stopImmediatePropagation();
      URL.revokeObjectURL(bootstrap);
      if (!m.id) { console.error(m.error); return; }
      try {
        const response = await fetchResource(m.url, { method: m.method });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (live) worker.postMessage({ sulfurResource: key, id: m.id, bytes, mime: response.headers.get('Content-Type') }, [bytes.buffer]);
      } catch (error) {
        if (live) worker.postMessage({ sulfurResource: key, id: m.id, error: String(error?.message || error) });
      }
    });
    return worker;
  }
  if (OriginalWorker) {
    ResourceWorker.prototype = OriginalWorker.prototype;
    Object.setPrototypeOf(ResourceWorker, OriginalWorker);
    globalThis.Worker = ResourceWorker;
  }
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const worker of workers) worker.terminate();
      workers.clear();
      globalThis.fetch = originalFetch;
      if (OriginalWorker) globalThis.Worker = OriginalWorker;
    },
  };
}
