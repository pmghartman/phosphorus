// the glyphs: every one a phrase of path data on a 16 grid, in three groups, from icons/default.ts;
// the stroke the stylesheet's own
import DEFAULT, { type IconSet } from './icons/default.ts';

export type { IconSet };
export type IconGroupName = 'files' | 'glyphs' | 'ui';

// a group's glyphs by name
export const iconGroup = (name: IconGroupName): Record<string, string> => DEFAULT[name];
