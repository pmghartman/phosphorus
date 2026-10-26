// Fully write a private staging folder before replacing the installed directory.
// Wait for every upload to settle before cleanup, including after one fails.
export async function installConvertedExtension(conversion, { directory, staging, backup, existing = false, write, rename, remove, beforeCommit = () => {}, progress = () => {}, concurrency = 4 }) {
  const files = [...Object.entries(conversion.files || {}).map(([path, text]) => ({ path, data: text, binary: false })),
    ...Object.entries(conversion.binary || {}).map(([path, data]) => ({ path, data, binary: true }))];
  if (!files.some((f) => f.path === 'package.json' && !f.binary)) throw new Error('The converted extension has no manifest');
  const names = new Set();
  for (const file of files) {
    if (!file.path || file.path.startsWith('/') || /[\\:\u0000-\u001f]/.test(file.path) || file.path.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error(`Invalid converted resource path: ${file.path}`);
    const name = file.path.toLowerCase();
    if (names.has(name)) throw new Error(`Duplicate converted resource path: ${file.path}`);
    names.add(name);
  }
  let cursor = 0, completed = 0, failed, moved = false, committed = false;
  try {
    const worker = async () => {
      while (!failed && cursor < files.length) {
        const file = files[cursor++];
        try {
          let data = file.data;
          if (file.binary) { const raw = atob(data); data = Uint8Array.from(raw, (c) => c.charCodeAt(0)); }
          await write(`${staging}/${file.path}`, data, file.binary);
          progress(++completed / files.length, file.path);
        } catch (error) { failed = error; }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency, files.length)) }, worker));
    if (failed) throw failed;
    await beforeCommit();
    if (existing) { await rename(directory, backup); moved = true; }
    try { await rename(staging, directory); committed = true; }
    catch (error) {
      if (moved) {
        try { await rename(backup, directory); moved = false; }
        catch (restoreError) { throw new Error(`${error.message}; restoring the previous extension failed: ${restoreError.message}. Previous files remain at ${backup}`); }
      }
      throw error;
    }
  } finally {
    if (!committed) await remove(staging).catch(() => {});
    // A failed backup cleanup must not turn a successful installation into an error.
    if (committed && moved) await remove(backup).catch(() => {});
  }
}
