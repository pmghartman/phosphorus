const slash = (s) => String(s || '').replace(/\\/g, '/');
export const absolutePath = (s) => /^(?:[A-Za-z]:\/|\/)/.test(slash(s));
export function joinPath(base, path) {
  if (absolutePath(path)) return slash(path);
  const parts = slash(base).split('/');
  for (const part of slash(path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return parts.join('/');
}
