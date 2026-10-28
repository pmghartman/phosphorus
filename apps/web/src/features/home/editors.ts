// the editor's file kinds and open tabs, the code itself fetched on first open
import type { ShowFile } from '@phosphorus/wire';
import { filesPath } from './api.ts';

// by extension: highlight.js's language, the parser checking it, the line comment
export const CODE_EXT: Record<string, [string, string, string]> = {
  js: ['javascript', 'javascript', '//'], mjs: ['javascript', 'javascript', '//'], cjs: ['javascript', 'javascript', '//'], jsx: ['javascript', 'javascript:jsx', '//'],
  ts: ['typescript', 'javascript:ts', '//'], mts: ['typescript', 'javascript:ts', '//'], tsx: ['typescript', 'javascript:jsx ts', '//'],
  py: ['python', 'python', '#'], sh: ['bash', '', '#'], bash: ['bash', '', '#'], zsh: ['bash', '', '#'],
  c: ['c', 'cpp', '//'], h: ['c', 'cpp', '//'], cpp: ['cpp', 'cpp', '//'], cc: ['cpp', 'cpp', '//'], cxx: ['cpp', 'cpp', '//'], hpp: ['cpp', 'cpp', '//'],
  go: ['go', 'go', '//'], rs: ['rust', 'rust', '//'], java: ['java', 'java', '//'], rb: ['ruby', '', '#'], lua: ['lua', '', '--'],
  cs: ['csharp', '', '//'], kt: ['kotlin', '', '//'], swift: ['swift', '', '//'], php: ['php', 'php', '//'], r: ['r', '', '#'],
  scala: ['scala', '', '//'], dart: ['dart', '', '//'], ex: ['elixir', '', '#'], exs: ['elixir', '', '#'], hs: ['haskell', '', '--'],
  jl: ['julia', '', '#'], nix: ['nix', '', '#'], ps1: ['powershell', '', '#'], sql: ['sql', '', '--'], proto: ['protobuf', '', '//'],
  css: ['css', 'css', ''], scss: ['scss', '', '//'], html: ['xml', 'html', ''], htm: ['xml', 'html', ''], xml: ['xml', 'xml', ''], svg: ['xml', 'xml', ''],
  json: ['json', 'json', ''], yml: ['yaml', 'yaml', '#'], yaml: ['yaml', 'yaml', '#'], toml: ['ini', '', '#'], ini: ['ini', '', ';'], conf: ['ini', '', '#'],
  cfg: ['ini', '', '#'], env: ['bash', '', '#'], md: ['markdown', '', ''], tex: ['latex', '', '%'], cmake: ['cmake', '', '#'],
  txt: ['plaintext', '', ''], log: ['plaintext', '', ''], csv: ['plaintext', '', ''],
};
export const CODE_NAMES: Record<string, [string, string, string]> = { dockerfile: ['dockerfile', '', '#'], makefile: ['makefile', '', '#'], 'cmakelists.txt': ['cmake', '', '#'] };
export function codeLang(p: string | null | undefined): { hl: string; check: string; comment: string } | null {
  const base = String(p || '').split('/').pop()!.toLowerCase();
  const hit = CODE_NAMES[base] || (base.includes('.') && CODE_EXT[base.split('.').pop()!]);
  return hit ? { hl: hit[0], check: hit[1], comment: hit[2] } : null;
}
// any text kind the editor knows, code or prose: what a double click opens in it
export const isCode = (p: string) => !!codeLang(p);

// a file to edit: host, share, path, and its label as the files tab names it
export type EditorFile = ShowFile;

// tab id -> its editor, host\nshare\npath -> its id
export const editors = new Map<string, { file?: EditorFile }>();
export const codeTabs = new Map<string, string>();
export const codeKey = (f: EditorFile) => `${f.host}\n${f.share}\n${f.path}`;
export const codeName = (f: EditorFile) => f.path.split('/').pop() || f.path;

// a file as the files tab names it: host, then the share's root, then the path
export const fileLabel = (host: string, root: string, rel: string) => filesPath(host, root, rel);
