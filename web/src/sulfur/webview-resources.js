const MIME = { js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', css: 'text/css', html: 'text/html', json: 'application/json', wasm: 'application/wasm',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', bin: 'application/octet-stream', txt: 'text/plain' };
const RESOURCE = /sulfur-res:(?:\/\/)?(\/[^"'\s)<>`]+)/g;
const absolute = (p) => { const out = []; for (const s of p.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); } return `/${out.join('/')}`; };
const local = (u) => !/^(?:[a-z][\w+.-]*:|#|\/\/)/i.test(u) || u.startsWith('sulfur-res:');

export function navigateWebview(view, html) {
  view.documentToken = crypto.randomUUID();
  view.pendingHTML = html;
  view.frame.removeAttribute('srcdoc');
  view.frame.src = `/sulfur/webview.html#${view.documentToken}`;
}

export function deliverWebviewDocument(view, token) {
  if (token !== view.documentToken || view.pendingHTML === undefined) return false;
  view.frame.contentWindow.postMessage({ sulfurWebviewToken: token, html: view.pendingHTML }, '*');
  delete view.pendingHTML;
  return true;
}

// Cache within a webview; bounded parallel reads keep a large page responsive and
// deduplicate shared fonts/styles. Disposing aborts both active and queued reads.
export function createWebviewResources(read, { concurrency = 6, onError = () => {} } = {}) {
  const cache = new Map(), dependencies = new Map(), waiting = [], controller = new AbortController();
  const limit = Math.max(1, Math.min(16, Number(concurrency) || 6));
  let active = 0;
  const load = async (path) => {
    while (active >= limit) { controller.signal.throwIfAborted(); await new Promise((resolve) => waiting.push(resolve)); }
    controller.signal.throwIfAborted();
    active++;
    try { return await read(path, controller.signal); }
    finally { active--; waiting.shift()?.(); }
  };
  function resource(input, trail = []) {
    const hash = input.indexOf('#'), suffix = hash < 0 ? '' : input.slice(hash);
    let path = input.replace(/^sulfur-res:(?:\/\/)?/, '').split(/[?#]/)[0];
    try { path = decodeURIComponent(path); } catch {}
    path = absolute(path);
    if (trail.includes(path)) return Promise.reject(new Error(`Cyclic stylesheet resource: ${path}`));
    const parent = trail[trail.length - 1];
    if (parent) {
      const reaches = (from, seen = new Set()) => {
        if (from === parent) return true;
        if (seen.has(from)) return false;
        seen.add(from);
        return [...(dependencies.get(from) || [])].some((next) => reaches(next, seen));
      };
      if (reaches(path)) return Promise.reject(new Error(`Cyclic stylesheet resource: ${path}`));
      if (!dependencies.has(parent)) dependencies.set(parent, new Set());
      dependencies.get(parent).add(path);
    }
    if (!cache.has(path)) {
      const job = (async () => {
        const ext = path.split('.').pop().toLowerCase();
        let bytes = await load(path);
        if (ext === 'css') {
          let css = new TextDecoder().decode(bytes);
          const refs = [...new Set([...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+['"]([^'"]+)['"]/g)].map((m) => m[2] || m[3]).filter(local))];
          const replacements = await Promise.all(refs.map(async (ref) => {
            const target = ref.startsWith('sulfur-res:') ? ref : ref.startsWith('/') ? ref : `${path.slice(0, path.lastIndexOf('/'))}/${ref}`;
            try { return [ref, await resource(target, [...trail, path])]; }
            catch (error) { onError(error); return [ref, ref]; }
          }));
          // Replace original tokens in one pass: inserted data must never be
          // searched again as if it were an original relative path.
          const values = new Map(replacements);
          css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+['"]([^'"]+)['"]/g,
            (all, quote, url, imported) => url ? `url("${values.get(url) || url}")` : `@import "${values.get(imported) || imported}"`);
          bytes = new TextEncoder().encode(css);
        }
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return `data:${MIME[ext] || 'application/octet-stream'};base64,${btoa(binary)}`;
      })();
      cache.set(path, job);
      job.catch(() => { if (cache.get(path) === job) cache.delete(path); });
    }
    return cache.get(path).then((url) => url + suffix);
  }
  return {
    url: resource,
    async html(input) {
      const source = String(input);
      const refs = [...new Set([...source.matchAll(RESOURCE)].map((m) => m[0]))];
      const replacements = new Map(await Promise.all(refs.map(async (ref) => {
        try { return [ref, await resource(ref)]; }
        catch (error) { onError(error); return [ref, ref]; }
      })));
      controller.signal.throwIfAborted();
      return source.replace(RESOURCE, (ref) => replacements.get(ref) || ref);
    },
    dispose() { controller.abort(); cache.clear(); dependencies.clear(); for (const resume of waiting.splice(0)) resume(); },
  };
}
