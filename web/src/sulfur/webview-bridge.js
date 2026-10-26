// Serialized into the webview. All dependencies are browser globals or arguments.
export function webviewBridge(initialState, theme, localEntries = {}, sessionEntries = {}, installResources, revision) {
  let state = initialState;
  const post = (message) => parent.postMessage(message, '*');
  const api = {
    postMessage: (message) => post({ phosphorusWebview: message }),
    getState: () => state === null ? undefined : state,
    setState: (value) => { state = value; post({ phosphorusWebviewState: value }); return value; },
  };
  window.acquireVsCodeApi = () => api;
  const pending = new Map();
  let sequence = 0;
  if (installResources) installResources((method, path) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Webview resource timed out: ${path}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    post({ sulfurWebviewResource: { id, path, revision } });
  }));
  function applyTheme(value) {
    const body = document.body;
    if (!body) return;
    body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light');
    body.classList.add(value.kind);
    body.dataset.vscodeThemeKind = value.kind;
    body.dataset.vscodeThemeId = value.id || 'Sulfur';
    for (const [name, token] of Object.entries(value.vars || {})) if (/^--(?:vscode|ide)-[\w-]+$/.test(name)) document.documentElement.style.setProperty(name, token);
  }
  const stores = new Map();
  for (const [name, scope, initial] of [['localStorage', 'local', localEntries], ['sessionStorage', 'session', sessionEntries]]) {
    try { if (window[name]) continue; } catch {}
    const entries = Object.assign(Object.create(null), Object.fromEntries(Object.entries(initial).filter(([, value]) => typeof value === 'string')));
    const apply = ({ action, key, value }) => {
      if (action === 'clear') for (const k of Object.keys(entries)) delete entries[k];
      else if (action === 'remove') delete entries[key];
      else if (action === 'set') entries[key] = value;
    };
    const change = (action, key, value) => {
      if (action === 'set') {
        const size = Object.entries(entries).reduce((n, [k, v]) => n + (k === key ? 0 : k.length + v.length), key.length + value.length);
        if (size > (1 << 19)) throw new DOMException('Extension storage quota exceeded', 'QuotaExceededError');
      }
      apply({ action, key, value });
      post({ phosphorusWebviewStorage: { scope, action, key, value } });
    };
    const methods = {
      get length() { return Object.keys(entries).length; },
      key: (index) => Object.keys(entries)[Number(index) >>> 0] ?? null,
      getItem: (key) => entries[String(key)] ?? null,
      setItem: (key, value) => change('set', String(key), String(value)),
      removeItem: (key) => change('remove', String(key)),
      clear: () => change('clear'),
    };
    const storage = new Proxy(methods, {
      get: (target, key) => key === Symbol.toStringTag ? 'Storage' : key in target ? target[key] : entries[key],
      set: (target, key, value) => { change('set', String(key), String(value)); return true; },
      deleteProperty: (target, key) => { change('remove', String(key)); return true; },
      ownKeys: () => Object.keys(entries),
      getOwnPropertyDescriptor: (target, key) => key in entries ? { value: entries[key], enumerable: true, configurable: true, writable: true } : undefined,
    });
    Object.defineProperty(window, name, { configurable: true, value: storage });
    stores.set(scope, apply);
  }
  addEventListener('message', (event) => {
    if (event.source !== parent) return;
    if (event.data?.sulfurWebviewResourceResult) {
      const result = event.data.sulfurWebviewResourceResult, job = pending.get(result.id);
      if (job) { clearTimeout(job.timer); pending.delete(result.id); if (result.error) job.reject(new Error(result.error)); else job.resolve(result.bytes); }
    } else if (event.data?.sulfurWebviewTheme) {
      theme = event.data.sulfurWebviewTheme.kind;
      applyTheme(event.data.sulfurWebviewTheme);
    } else if (event.data?.sulfurWebviewStorageSync) {
      const update = event.data.sulfurWebviewStorageSync;
      stores.get(update.scope)?.(update);
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme({ kind: theme });
    post({ sulfurWebviewLoaded: revision });
  });
}

export function applyWebviewStorage(entries, update) {
  if (!update || !['local', 'session'].includes(update.scope)) return false;
  const { action, key, value } = update;
  if (action === 'clear') { for (const k of Object.keys(entries)) delete entries[k]; return true; }
  if (typeof key !== 'string') return false;
  if (action === 'remove') { delete entries[key]; return true; }
  if (action !== 'set' || typeof value !== 'string') return false;
  const size = Object.entries(entries).reduce((n, [k, v]) => n + (k === key ? 0 : k.length + String(v).length), key.length + value.length);
  if (size > (1 << 19)) return false;
  Object.defineProperty(entries, key, { value, configurable: true, enumerable: true, writable: true });
  return true;
}
