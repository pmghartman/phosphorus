const letters = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', T: 'M', '?': 'U' };
export const SCM_STATES = {
  M: { label: 'Modified', color: 'modified', rank: 4 },
  A: { label: 'Added', color: 'added', rank: 2 },
  D: { label: 'Deleted', color: 'deleted', rank: 5 },
  R: { label: 'Renamed', color: 'renamed', rank: 3 },
  C: { label: 'Copied', color: 'added', rank: 2 },
  U: { label: 'Untracked', color: 'untracked', rank: 1 },
  '!': { label: 'Merge conflict', color: 'conflict', rank: 6 },
};

// Porcelain -z paths are raw (including spaces and newlines); a rename/copy's
// destination comes first and its source occupies the next NUL-delimited field.
export function parseGitStatus(output) {
  const state = { branch: '', upstream: '', ahead: 0, behind: 0, unborn: false, staged: [], changes: [] };
  const parts = output.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith('## ')) {
      const header = entry.slice(3);
      const match = header.match(/^(?:(?:No commits yet on|Initial commit on) )?([^.\s]+(?:\.(?!\.)[^.\s]*)*)(?:\.\.\.(\S+))?(?: \[(.*)\])?/);
      state.branch = match?.[1] || header;
      // a repository with no commits yet: nothing to restore the index from
      state.unborn = /^(No commits yet on|Initial commit on) /.test(header);
      state.upstream = match?.[2] || '';
      state.ahead = Number((match?.[3] || '').match(/ahead (\d+)/)?.[1] || 0);
      state.behind = Number((match?.[3] || '').match(/behind (\d+)/)?.[1] || 0);
      continue;
    }
    const [x, y] = entry;
    const path = entry.slice(3);
    const from = /[RC]/.test(x + y) ? parts[++i] || '' : '';
    if (x === '?' && y === '?') { state.changes.push({ path, code: 'U', untracked: true }); continue; }
    if (x === '!' && y === '!') continue;
    if (x === 'U' || y === 'U' || x === 'A' && y === 'A' || x === 'D' && y === 'D') { state.changes.push({ path, code: '!', conflict: true }); continue; }
    if (x !== ' ') state.staged.push({ path, from, code: letters[x] || x, deleted: x === 'D' });
    if (y !== ' ') state.changes.push({ path, from, code: letters[y] || y, deleted: y === 'D' });
  }
  return state;
}

export function explorerChanges(state, root) {
  const files = new Map(), folders = new Map();
  if (!state?.top) return { files, folders };
  const prefix = state.prefix || '';
  const renameSources = new Map();
  const localPath = (path) => {
    if (!path || prefix && !path.startsWith(prefix)) return null;
    const relative = path.slice(prefix.length);
    return relative && relative.split('/').every((part) => part && part !== '.' && part !== '..') ? `${root}/${relative}` : null;
  };
  for (const [items, staged] of [[state.staged, true], [state.changes, false]]) for (const item of items || []) {
    if (!SCM_STATES[item.code]) continue;
    const path = localPath(item.path);
    const from = item.code === 'R' && localPath(item.from);
    if (from) renameSources.set(from, { ...SCM_STATES.R, code: 'R', id: item.path });
    if (!path) continue;
    const previous = files.get(path);
    files.set(path, { code: previous?.code === '!' ? '!' : item.code, staged: staged || !!previous?.staged, unstaged: !staged || !!previous?.unstaged, from: item.from || previous?.from || '' });
  }
  for (const [path, item] of files) {
    const info = SCM_STATES[item.code];
    Object.assign(item, info, { badge: item.code, title: `${info.label}${item.from ? ` from ${item.from}` : ''}${item.staged && item.unstaged ? ' (staged and unstaged changes)' : item.staged ? ' (staged)' : ''}` });
  }
  const addFolders = (path, item, id) => {
    let dir = path.slice(0, path.lastIndexOf('/'));
    while (dir === root || dir.startsWith(root + '/')) {
      const previous = folders.get(dir);
      const codes = previous?.codes || new Set(); codes.add(item.code);
      const paths = previous?.paths || new Set(); paths.add(id);
      const dominant = !previous || item.rank > previous.rank ? item : previous;
      folders.set(dir, { color: dominant.color, rank: dominant.rank, codes, paths, count: paths.size, badge: '●' });
      if (dir === root) break;
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
  };
  for (const [path, item] of files) addFolders(path, item, path.slice(root.length + 1));
  for (const [path, item] of renameSources) addFolders(path, item, item.id.slice(prefix.length));
  for (const folder of folders.values()) folder.title = `${folder.count} changed ${folder.count === 1 ? 'file' : 'files'}: ${[...folder.codes].map((code) => SCM_STATES[code].label.toLowerCase()).join(', ')}`;
  return { files, folders };
}
