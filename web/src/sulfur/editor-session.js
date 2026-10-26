// Store references and cursor positions, never file contents. A session belongs to
// a workspace's location and root, so identical paths on two machines stay apart.
export function captureEditorSession(tabs, active, keep) {
  const files = tabs.filter((t) => t.rel);
  return {
    tabs: files.map((t) => {
      const file = keep(t);
      const selection = t.ed?.ready() ? t.ed.selection() : t.pendingSel;
      return { ...(typeof file === 'string' ? { rel: file } : file),
        ...(Array.isArray(selection) ? { selection: [...selection] } : {}) };
    }),
    active: active?.rel ? keep(active) : '',
  };
}

export function rememberEditorSession(sessions, key, session, limit = 24) {
  // Reinserting the current workspace keeps recently visited folders first.
  return Object.fromEntries([[key, session], ...Object.entries(sessions || {}).filter(([k]) => k !== key)].slice(0, limit));
}

export function restoredSelection(file) {
  const s = file?.selection;
  return Array.isArray(s) && s.length === 2 && s.every((n) => Number.isSafeInteger(n) && n >= 0) ? s : undefined;
}
