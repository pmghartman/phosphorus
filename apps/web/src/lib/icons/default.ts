// a set's shape: its stroke, and each group's glyphs by name
export interface IconSet {
  id: string;
  label: string;
  stroke: { width: number; cap: string; join: string };
  files: Record<string, string>;
  glyphs: Record<string, string>;
  ui: Record<string, string>;
}

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

// the settings' gear: eight square teeth round a hub, the bar's and the desktop's alike
const gear =
  'M6.66 3.18L6.84 1.50L9.16 1.50L9.34 3.18L10.46 3.65L11.77 2.59L13.41 4.23L12.35 5.54L12.82 6.66L14.50 6.84L14.50 9.16L12.82 9.34L12.35 10.46L13.41 11.77L11.77 13.41L10.46 12.35L9.34 12.82L9.16 14.50L6.84 14.50L6.66 12.82L5.54 12.35L4.23 13.41L2.59 11.77L3.65 10.46L3.18 9.34L1.50 9.16L1.50 6.84L3.18 6.66L3.65 5.54L2.59 4.23L4.23 2.59L5.54 3.65zM5.90 8a2.1 2.1 0 1 0 4.20 0a2.1 2.1 0 1 0 -4.20 0z';

const set: IconSet = {
  id: 'default',
  label: 'default',
  stroke: { width: 1.3, cap: 'round', join: 'round' },
  // the file manager's actions and kinds
  files: icons,
  // the desktop's apps and the bar's tools
  glyphs: {
    bell: 'M8 2.2a3.1 3.1 0 0 0-3.1 3.1v2.2L3.4 10.2h9.2L11.1 7.5V5.3A3.1 3.1 0 0 0 8 2.2zM6.6 12.6a1.4 1.4 0 0 0 2.8 0',
    // a release coming down into the hosts
    update: 'M8 1.5v8.5M4.5 6.5L8 10l3.5-3.5M2 10.5v3h12v-3',
    gear,
    settings: gear,
    power: 'M8 1.5v6M4.6 3.8a5 5 0 1 0 6.8 0',
    spark: 'M8 1.5l1.4 5.1 5.1 1.4-5.1 1.4L8 14.5l-1.4-5.1L1.5 8l5.1-1.4z',
    reload: 'M13.5 8a5.5 5.5 0 1 1-1.8-4.1M13.5 1.5v3.5h-3.5',
    download: 'M8 2v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11',
    doc: icons.file,
    app: 'M2.5 2.5h11v11h-11zM2.5 5.5h11M4.25 4h.01M5.75 4h.01M6 8.5l-1.5 1.5L6 11.5M10 8.5l1.5 1.5-1.5 1.5',
    terminal: 'M2 3h12v10H2zM4.5 6.5l2 1.5-2 1.5M8 10h3.5',
    files: icons.folder,
    // phosphorus itself: the mark's own Φ (favicon.svg), filled in the icon's colour
    phi: 'M4.09 10.33Q4.57 11.14 5.32 11.49Q6.06 11.85 7.03 11.85L7.03 4.07L6.63 4.07Q5.78 4.07 5.17 4.4Q4.56 4.74 4.15 5.36Q3.82 5.89 3.66 6.58Q3.5 7.27 3.5 7.97Q3.5 8.45 3.59 9.04Q3.68 9.62 4.09 10.33ZM11.9 10.33Q12.27 9.71 12.38 9.07Q12.5 8.43 12.5 7.97Q12.5 7.37 12.34 6.63Q12.18 5.89 11.85 5.36Q11.49 4.8 10.88 4.43Q10.27 4.07 9.37 4.07L8.97 4.07L8.97 11.85Q9.99 11.85 10.74 11.44Q11.48 11.03 11.9 10.33ZM13.05 11.37Q12.28 11.97 11.24 12.29Q10.2 12.61 8.96 12.61L8.96 13.03Q8.96 13.36 9.07 13.57Q9.18 13.79 9.52 13.92Q9.68 13.98 10.1 14.03Q10.52 14.09 10.87 14.09L10.87 14.75L5.25 14.75L5.25 14.09Q5.47 14.08 5.9 14.03Q6.33 13.99 6.49 13.92Q6.77 13.8 6.91 13.58Q7.04 13.36 7.04 13.03L7.04 12.61Q5.8 12.61 4.75 12.3Q3.7 11.99 2.92 11.37Q2.15 10.76 1.72 9.85Q1.28 8.94 1.28 7.74Q1.28 6.83 1.6 6.05Q1.91 5.27 2.62 4.64Q3.3 4.03 4.39 3.68Q5.47 3.33 6.94 3.33L7.04 3.33L7.04 3.07Q7.04 2.77 6.93 2.55Q6.82 2.33 6.49 2.19Q6.22 2.07 5.86 2Q5.5 1.92 5.23 1.91L5.23 1.25L10.77 1.25L10.77 1.91Q10.5 1.91 10.14 1.96Q9.79 2 9.52 2.09Q9.2 2.2 9.08 2.43Q8.96 2.66 8.96 2.98L8.96 3.33L9.06 3.33Q10.53 3.33 11.6 3.67Q12.68 4.02 13.38 4.64Q14.07 5.25 14.39 6.05Q14.72 6.84 14.72 7.74Q14.72 8.92 14.26 9.85Q13.81 10.77 13.05 11.37Z',
    // the apps menu: a launcher's grid
    grid: 'M2.5 2.5h2v2h-2zM7 2.5h2v2H7zM11.5 2.5h2v2h-2zM2.5 7h2v2h-2zM7 7h2v2H7zM11.5 7h2v2h-2zM2.5 11.5h2v2h-2zM7 11.5h2v2H7zM11.5 11.5h2v2h-2z',
    // a disk: its case, a light at its edge
    drive: 'M1.5 9h13v4.5h-13zM3 9l1.6-5.5h6.8L13 9M11.5 11.25h.01',
    editor: 'M1.5 2.5h13v11h-13zM1.5 5h13M5.5 7.5L3.75 9.25 5.5 11M10.5 7.5l1.75 1.75L10.5 11M8.75 7l-1.5 4.5',
    service:
      'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c-2.2 2.4-2.2 10.6 0 13M8 1.5c2.2 2.4 2.2 10.6 0 13',
    chat: 'M2 2.5h12v8H6.5L3.5 13v-2.5H2zM4.5 5.5h7M4.5 8h4.5',
    status: 'M1.5 8h3l1.5-4 3 8 1.5-4h4',
    code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 2.5l-2 11',
    agents: 'M4.5 4.5h7v7h-7zM6.5 6.5h3v3h-3zM6 1.5v3M10 1.5v3M6 11.5v3M10 11.5v3M1.5 6h3M1.5 10h3M11.5 6h3M11.5 10h3',
    games:
      'M2.5 5h11a1 1 0 0 1 1 1v5a2 2 0 0 1-3.5 1.3L9.5 11h-3L5 12.3A2 2 0 0 1 1.5 11V6a1 1 0 0 1 1-1zM4.5 7v2.5M3.25 8.25h2.5M10.5 7.5h.01M12 9h.01',
    about: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 7v4.5M8 4.75h.01',
    // the service wizard: a wizard's hat, its tip curled over, a band round it
    apps: 'M1.5 13c2 1.2 11 1.2 13 0M3.8 12.7L7.5 3.2C8.4 1.5 10.5 1.2 12 2.5c-1.5-.2-2.6.6-2.6 2.2l2.8 8M5.2 9.8c1.6.7 4 .7 5.7 0',
    mesh: 'M6.5 1.5h3v3h-3zM1.5 11.5h3v3h-3zM11.5 11.5h3v3h-3zM7.2 4.5l-3.4 7M8.8 4.5l3.4 7M4.5 13h7',
    lock: 'M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5',
    crown: 'M5.6 3.9L5 1.2l1.7 1.3L8 .6l1.3 1.9L11 1.2l-.6 2.7z',
    user: 'M8 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5',
    users:
      'M6 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM1.5 13.5c.4-2.6 2.2-4 4.5-4s4.1 1.4 4.5 4M11 3a2 2 0 0 1 0 4M12.5 9.8c1.2.5 1.9 1.7 2 3.7',
    palette:
      'M8 1.5a6.5 6.5 0 1 0 0 13c1.1 0 1.6-.7 1.3-1.5-.4-1 .2-1.9 1.3-1.9h1.4A2.5 2.5 0 0 0 14.5 8.6 6.6 6.6 0 0 0 8 1.5zM5.2 6.2h.01M8 4.2h.01M10.8 6.2h.01M4.6 9.4h.01',
    key: 'M10 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM7.2 8.8L2 14v1.5h2.5V14H6v-1.5h1.5L9 11',
    // a device's OS, beside its name
    windows: 'M2.5 2.5h4.2v4.2H2.5zM9.3 2.5h4.2v4.2H9.3zM2.5 9.3h4.2v4.2H2.5zM9.3 9.3h4.2v4.2H9.3z',
    apple:
      'M8 4.6C7.3 4.15 6.45 3.9 5.65 3.95 3.9 4.05 2.75 5.6 2.75 7.75 2.75 10.75 4.65 14 6.2 14c.75 0 1.1-.4 1.8-.4s1.05.4 1.8.4c1.15 0 2.4-1.75 3-3.5-1.2-.55-1.95-1.7-1.95-3 0-1.15.6-2.15 1.5-2.7-.6-.85-1.55-.9-2.35-.9S8.5 4.25 8 4.6zM8.15 3.6c-.05-1.15.75-2.1 1.95-2.2.05 1.15-.8 2.1-1.95 2.2z',
    linux:
      'M8 1.75c-1.7 0-2.85 1.3-2.85 3.1v1.5C3.8 7.6 2.9 9.3 2.9 11c0 2 2.2 3.25 5.1 3.25s5.1-1.25 5.1-3.25c0-1.7-.9-3.4-2.25-4.65v-1.5c0-1.8-1.15-3.1-2.85-3.1zM6.9 4.5v.3M9.1 4.5v.3M7.2 6.1l.8.55.8-.55',
    search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.3 10.3l3.7 3.7',
  },
  // window and navigation controls
  ui: {
    min: 'M4 11.5h8',
    max: 'M3.5 3.5h9v9h-9z',
    close: 'M4 4l8 8M12 4l-8 8',
    plus: 'M8 3v10M3 8h10',
    pop: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v4H2.5V4h4',
    back: 'M10 3L5 8l5 5',
    fwd: 'M6 3l5 5-5 5',
    up: 'M3 10.5l5-5 5 5',
    down: 'M3 5.5l5 5 5-5',
    list: 'M2.5 4h11M2.5 8h11M2.5 12h11',
    // a drag handle: two columns of three dots
    grip: 'M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01',
    desk: 'M1.5 2.5h13v8.5h-13zM5.5 13.5h5M8 11v2.5M4 5h3M4 7.5h2',
  },
};
export default set;
