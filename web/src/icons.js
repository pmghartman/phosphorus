// the icon sets: each a data file under icons/, named in a theme's `icons` field. A set gives
// every glyph's path data in three groups and how they are stroked; one not in the set, or a set
// not here, falls back to the default's. The page reads glyphs through iconGroup, so a set change
// shows on the next draw.
import DEFAULT from './icons/default.js';

export const ICON_SETS = { [DEFAULT.id]: DEFAULT };
export const ICON_EVENT = 'phosphorus-icons';
let active = DEFAULT;

export const iconSetNow = () => active.id;

// a set worn: its stroke on the page, the stylesheet drawing every icon from it
export function setIconSet(id) {
  const next = ICON_SETS[id] || DEFAULT;
  const changed = next !== active;
  active = next;
  const style = document.documentElement.style;
  style.setProperty('--ic-w', String(active.stroke.width));
  style.setProperty('--ic-cap', active.stroke.cap);
  style.setProperty('--ic-join', active.stroke.join);
  if (changed) dispatchEvent(new CustomEvent(ICON_EVENT, { detail: active.id }));
}

// a group's glyphs by name, from the set worn, else the default's
export const iconGroup = (name) => new Proxy({}, {
  get: (_, key) => active[name]?.[key] ?? DEFAULT[name][key],
  has: (_, key) => key in active[name] || key in DEFAULT[name],
  ownKeys: () => Object.keys({ ...DEFAULT[name], ...active[name] }),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});
