// context
import type { ModelHost } from '@phosphorus/wire';

// the last ask against the model's context window, as claude code's /context
// draws it: a cell a hundredth of the window, each part its own hue

export const CTX_CELLS = 100;
export const CTX_PARTS: [string, string][] = [['system', 'system prompt'], ['chat', 'chat'], ['ask', 'prompt'], ['reply', 'reply']];

export const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n)));
const tenth = (f: number) => `${(f * 100).toFixed(1)}%`;

// the window's hundred cells, each part's share
export function ctxCells(m: ModelHost) {
  const use: Record<string, number | undefined> = m.use || {};
  const parts = CTX_PARTS.map(([k, label]): [string, string, number] => [k, label, Math.min(use[k] || 0, m.ctx!)]);
  const used = Math.min(m.ctx!, parts.reduce((a, [, , n]) => a + n, 0));
  const per = m.ctx! / CTX_CELLS;
  // whole cells first, a part's remainder as half a cell
  const cells: string[] = [];
  for (const [k, , n] of parts) {
    for (let i = 0; i < Math.floor(n / per); i++) cells.push(`<i class="ctx-${k} full"></i>`);
    if (n % per) cells.push(`<i class="ctx-${k} half"></i>`);
  }
  cells.length = Math.min(cells.length, CTX_CELLS);
  while (cells.length < CTX_CELLS) cells.push('<i></i>');
  return { cells: cells.join(''), parts, used };
}
