// a set's shape: its stroke, and each group's glyphs by name
export interface IconSet { id: string; label: string; stroke: { width: number; cap: string; join: string }; files: Record<string, string>; glyphs: Record<string, string>; ui: Record<string, string> }

// the default icon set: every glyph a phrase of path data on a 16 grid, stroked in one weight.
// A set names itself, says how it is stroked, and gives each group its glyphs; see ../icons.ts.
const icons: Record<string, string> = {
  folder: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13z',
  file: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3',
  download: 'M8 2v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11',
  rename: 'M11.5 1.8l2.7 2.7-8.2 8.2-3.5.8.8-3.5zM9.8 3.5l2.7 2.7',
  trash: 'M2.5 4h11M6 4V2.2h4V4M4 4l.7 10h6.6L12 4M6.4 6.5v5M9.6 6.5v5',
  mkdir: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13zM8 7.5v4M6 9.5h4',
  upload: 'M8 10.5v-8M4.5 5.5L8 2l3.5 3.5M2.5 13.5h11',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.8-4.1M13.5 1.5v3.5h-3.5',
  split: 'M1.5 2.5h13v11h-13zM8 2.5v11',
  view: 'M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  host: 'M1.5 2.5h13v4.5h-13zM1.5 9h13v4.5h-13zM4 4.75h1.5M4 11.25h1.5',
};

const set: IconSet = {
  id: 'default',
  label: 'default',
  stroke: { width: 1.3, cap: 'round', join: 'round' },
  // the file manager's actions and kinds
  files: icons,
  // the desktop's apps and the bar's tools
  glyphs: {
  bell: 'M8 2.2a3.1 3.1 0 0 0-3.1 3.1v2.2L3.4 10.2h9.2L11.1 7.5V5.3A3.1 3.1 0 0 0 8 2.2zM6.6 12.6a1.4 1.4 0 0 0 2.8 0',
  update: 'M8 10.5v-8M4.8 5.5L8 2.5l3.2 3M2.5 9v4.5h11V9',
  gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  power: 'M8 1.5v6M4.6 3.8a5 5 0 1 0 6.8 0',
  spark: 'M8 1.5l1.4 5.1 5.1 1.4-5.1 1.4L8 14.5l-1.4-5.1L1.5 8l5.1-1.4z',
  reload: 'M13.5 8a5.5 5.5 0 1 1-1.8-4.1M13.5 1.5v3.5h-3.5',
  download: 'M8 2v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11',
  doc: icons.file,
  app: 'M2.5 2.5h11v11h-11zM2.5 5.5h11M4.25 4h.01M5.75 4h.01M6 8.5l-1.5 1.5L6 11.5M10 8.5l1.5 1.5-1.5 1.5',
  terminal: 'M2 3h12v10H2zM4.5 6.5l2 1.5-2 1.5M8 10h3.5',
  files: icons.folder,
  editor: 'M1.5 2.5h13v11h-13zM1.5 5h13M5.5 7.5L3.75 9.25 5.5 11M10.5 7.5l1.75 1.75L10.5 11M8.75 7l-1.5 4.5',
  service: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c-2.2 2.4-2.2 10.6 0 13M8 1.5c2.2 2.4 2.2 10.6 0 13',
  chat: 'M2 2.5h12v8H6.5L3.5 13v-2.5H2zM4.5 5.5h7M4.5 8h4.5',
  status: 'M1.5 8h3l1.5-4 3 8 1.5-4h4',
  git: 'M4.5 2v8M4.5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11.5 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11.5 6c0 3-7 2-7 4',
  code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 2.5l-2 11',
  agents: 'M4.5 4.5h7v7h-7zM6.5 6.5h3v3h-3zM6 1.5v3M10 1.5v3M6 11.5v3M10 11.5v3M1.5 6h3M1.5 10h3M11.5 6h3M11.5 10h3',
  games: 'M2.5 5h11a1 1 0 0 1 1 1v5a2 2 0 0 1-3.5 1.3L9.5 11h-3L5 12.3A2 2 0 0 1 1.5 11V6a1 1 0 0 1 1-1zM4.5 7v2.5M3.25 8.25h2.5M10.5 7.5h.01M12 9h.01',
  about: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 7v4.5M8 4.75h.01',
  apps: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM11.5 9.5v5M9 12h5',
  mesh: 'M6.5 1.5h3v3h-3zM1.5 11.5h3v3h-3zM11.5 11.5h3v3h-3zM7.2 4.5l-3.4 7M8.8 4.5l3.4 7M4.5 13h7',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5',
  crown: 'M5.6 3.9L5 1.2l1.7 1.3L8 .6l1.3 1.9L11 1.2l-.6 2.7z',
  user: 'M8 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5',
  users: 'M6 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM1.5 13.5c.4-2.6 2.2-4 4.5-4s4.1 1.4 4.5 4M11 3a2 2 0 0 1 0 4M12.5 9.8c1.2.5 1.9 1.7 2 3.7',
  key: 'M10 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM7.2 8.8L2 14v1.5h2.5V14H6v-1.5h1.5L9 11',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.3 10.3l3.7 3.7',
  },
  // window and navigation controls
  ui: {
  min: 'M4 11.5h8', max: 'M3.5 3.5h9v9h-9z', close: 'M4 4l8 8M12 4l-8 8',
  pop: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v4H2.5V4h4',
  back: 'M10 3L5 8l5 5', fwd: 'M6 3l5 5-5 5', up: 'M3 10.5l5-5 5 5', down: 'M3 5.5l5 5 5-5',
  list: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  desk: 'M1.5 2.5h13v8.5h-13zM5.5 13.5h5M8 11v2.5M4 5h3M4 7.5h2',
  },
};
export default set;
