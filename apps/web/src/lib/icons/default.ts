// a set's shape: its stroke, and each group's glyphs by name
export interface IconSet {
  id: string;
  label: string;
  stroke: { width: number; cap: string; join: string };
  files: Record<string, string>;
  glyphs: Record<string, string>;
  ui: Record<string, string>;
}

// the default icon set: every glyph a phrase of path data on a 16 grid, stroked in one weight,
// drawn inside 1.75 to 14.25 with 1px corners, nothing ornamental. A set names itself, says how
// it is stroked, and gives each group its glyphs; see ../icons.ts.
const frame = 'M2 3.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z';
const folder = 'M2 4.5a1 1 0 0 1 1-1h3.25l1.5 1.5H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z';
const circle = 'M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5z';
const star = 'M8 1.75l1.55 4.7 4.7 1.55-4.7 1.55L8 14.25l-1.55-4.7-4.7-1.55 4.7-1.55z';
const refresh = 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V6H10';
const download = 'M8 2.5v8M4.75 7.25L8 10.5l3.25-3.25M3 13.5h10';

const icons: Record<string, string> = {
  folder,
  file: 'M4 1.75h5.5l3 3v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-11.5a.5.5 0 0 1 .5-.5zM9.5 1.75v3h3',
  download,
  rename: 'M11.3 2.2l2.5 2.5-8.3 8.3-3.3.8.8-3.3zM9.7 3.8l2.5 2.5',
  trash: 'M3 4h10M6.25 4V2.5h3.5V4M4.25 4l.6 9.5h6.3l.6-9.5M6.75 6.75v4.5M9.25 6.75v4.5',
  mkdir: `${folder}M8 7.25v4M6 9.25h4`,
  upload: 'M8 10.5v-8M4.75 5.75L8 2.5l3.25 3.25M3 13.5h10',
  refresh,
  split: `${frame}M8 2.5v11`,
  view: 'M1.5 8c1.6-3 3.8-4.5 6.5-4.5s4.9 1.5 6.5 4.5c-1.6 3-3.8 4.5-6.5 4.5S3.1 11 1.5 8zM8 5.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5z',
  host: 'M3 2h10a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM3 10h10a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1zM4.5 4h.01M4.5 12h.01',
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
    bell: 'M4 11V7a4 4 0 0 1 8 0v4l1.25 1.5H2.75zM6.75 14a1.25 1.25 0 0 0 2.5 0',
    // a release coming down into the hosts
    update: 'M8 2v8M4.75 6.75L8 10l3.25-3.25M2.5 11v2.5h11V11',
    gear,
    power: 'M8 1.75v6M4.75 4.25a4.75 4.75 0 1 0 6.5 0',
    spark: star,
    reload: refresh,
    download,
    doc: icons.file,
    // a window: its title bar over its page
    app: `${frame}M2 6h12`,
    terminal: `${frame}M4.75 6L7 8l-2.25 2M8.5 10.25H11`,
    files: folder,
    // phosphorus itself: the mark's own Φ (favicon.svg), filled in the icon's colour
    phi: 'M4.09 10.33Q4.57 11.14 5.32 11.49Q6.06 11.85 7.03 11.85L7.03 4.07L6.63 4.07Q5.78 4.07 5.17 4.4Q4.56 4.74 4.15 5.36Q3.82 5.89 3.66 6.58Q3.5 7.27 3.5 7.97Q3.5 8.45 3.59 9.04Q3.68 9.62 4.09 10.33ZM11.9 10.33Q12.27 9.71 12.38 9.07Q12.5 8.43 12.5 7.97Q12.5 7.37 12.34 6.63Q12.18 5.89 11.85 5.36Q11.49 4.8 10.88 4.43Q10.27 4.07 9.37 4.07L8.97 4.07L8.97 11.85Q9.99 11.85 10.74 11.44Q11.48 11.03 11.9 10.33ZM13.05 11.37Q12.28 11.97 11.24 12.29Q10.2 12.61 8.96 12.61L8.96 13.03Q8.96 13.36 9.07 13.57Q9.18 13.79 9.52 13.92Q9.68 13.98 10.1 14.03Q10.52 14.09 10.87 14.09L10.87 14.75L5.25 14.75L5.25 14.09Q5.47 14.08 5.9 14.03Q6.33 13.99 6.49 13.92Q6.77 13.8 6.91 13.58Q7.04 13.36 7.04 13.03L7.04 12.61Q5.8 12.61 4.75 12.3Q3.7 11.99 2.92 11.37Q2.15 10.76 1.72 9.85Q1.28 8.94 1.28 7.74Q1.28 6.83 1.6 6.05Q1.91 5.27 2.62 4.64Q3.3 4.03 4.39 3.68Q5.47 3.33 6.94 3.33L7.04 3.33L7.04 3.07Q7.04 2.77 6.93 2.55Q6.82 2.33 6.49 2.19Q6.22 2.07 5.86 2Q5.5 1.92 5.23 1.91L5.23 1.25L10.77 1.25L10.77 1.91Q10.5 1.91 10.14 1.96Q9.79 2 9.52 2.09Q9.2 2.2 9.08 2.43Q8.96 2.66 8.96 2.98L8.96 3.33L9.06 3.33Q10.53 3.33 11.6 3.67Q12.68 4.02 13.38 4.64Q14.07 5.25 14.39 6.05Q14.72 6.84 14.72 7.74Q14.72 8.92 14.26 9.85Q13.81 10.77 13.05 11.37Z',
    // the apps menu: a launcher's grid
    grid: 'M2.5 2.5h2v2h-2zM7 2.5h2v2H7zM11.5 2.5h2v2h-2zM2.5 7h2v2h-2zM7 7h2v2H7zM11.5 7h2v2h-2zM2.5 11.5h2v2h-2zM7 11.5h2v2H7zM11.5 11.5h2v2h-2z',
    // a disk: a flat case, a light at its right
    drive: 'M3 4h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM2 8.5h12M11.5 10.25h.01',
    editor: `${frame}M6 7.25L4.25 9 6 10.75M10 7.25L11.75 9 10 10.75`,
    service: `${circle}M1.75 8h12.5M8 1.75c-1.9 2-1.9 10.5 0 12.5M8 1.75c1.9 2 1.9 10.5 0 12.5`,
    chat: 'M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5h-.5a1 1 0 0 1-1-1z',
    status: 'M1.75 8h2.5l1.75-4 3.5 8 1.75-4h3',
    code: 'M5 4.5L1.75 8 5 11.5M11 4.5L14.25 8 11 11.5',
    agents: star,
    games:
      'M4.5 4.5h7a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3H10l-.75-1.25h-2.5L6 12.5H4.5a3 3 0 0 1-3-3v-2a3 3 0 0 1 3-3zM5 7.25v2.5M3.75 8.5h2.5M10.5 7.75h.01M12 9.25h.01',
    about: `${circle}M8 7.25V11M8 5.25h.01`,
    // the service wizard: a wizard's hat, its cone's tip curled over, a band, a wide brim
    apps: 'M2 12.5a6 1.25 0 1 0 12 0a6 1.25 0 1 0-12 0zM4.75 12L8.6 2.3c1 .3 1.7 1.1 2 1.9-.6-.3-1.1-.3-1.5-.1L11.25 12M5.65 9.75c1.5.6 3.5.6 5 0',
    mesh: 'M8 2.25a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM3.25 10.75a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12.75 10.75a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM7.25 5.1l-3.25 5.6M8.75 5.1l3.25 5.6M4.75 12.25h6.5',
    lock: 'M3.5 7.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1zM5.5 6.5V5a2.5 2.5 0 0 1 5 0v1.5',
    user: 'M8 2.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5zM3 14c.5-2.9 2.4-4.5 5-4.5s4.5 1.6 5 4.5',
    users:
      'M6 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM1.75 13.5c.4-2.5 2-3.9 4.25-3.9s3.85 1.4 4.25 3.9M10.75 3.25a2.5 2.5 0 0 1 0 4.5M12.25 9.9c1.2.5 1.85 1.7 2 3.6',
    palette:
      'M8 1.75a6.25 6.25 0 1 0 0 12.5c.9 0 1.5-.6 1.25-1.4-.3-.95.25-1.85 1.25-1.85h1.5a2.25 2.25 0 0 0 2.25-2.25A6.3 6.3 0 0 0 8 1.75zM5.25 6.25h.01M8 4.5h.01M10.75 6.25h.01',
    key: 'M10.5 2.25a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5zM8.2 7.8L2 14M4 12l1.5 1.5M6 10l1.5 1.5',
    // a device's OS, beside its name
    windows: 'M2.5 2.5h4.2v4.2H2.5zM9.3 2.5h4.2v4.2H9.3zM2.5 9.3h4.2v4.2H2.5zM9.3 9.3h4.2v4.2H9.3z',
    apple:
      'M8 4.6C7.3 4.15 6.45 3.9 5.65 3.95 3.9 4.05 2.75 5.6 2.75 7.75 2.75 10.75 4.65 14 6.2 14c.75 0 1.1-.4 1.8-.4s1.05.4 1.8.4c1.15 0 2.4-1.75 3-3.5-1.2-.55-1.95-1.7-1.95-3 0-1.15.6-2.15 1.5-2.7-.6-.85-1.55-.9-2.35-.9S8.5 4.25 8 4.6zM8.15 3.6c-.05-1.15.75-2.1 1.95-2.2.05 1.15-.8 2.1-1.95 2.2z',
    linux:
      'M8 1.75c-1.7 0-2.85 1.3-2.85 3.1v1.5C3.8 7.6 2.9 9.3 2.9 11c0 2 2.2 3.25 5.1 3.25s5.1-1.25 5.1-3.25c0-1.7-.9-3.4-2.25-4.65v-1.5c0-1.8-1.15-3.1-2.85-3.1zM6.9 4.5v.3M9.1 4.5v.3M7.2 6.1l.8.55.8-.55',
    search: 'M7 2.25a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5zM10.4 10.4l3.35 3.35',
  },
  // window and navigation controls
  ui: {
    min: 'M4 8h8',
    max: 'M3.5 3.5h9v9h-9z',
    close: 'M4 4l8 8M12 4l-8 8',
    plus: 'M8 3v10M3 8h10',
    pop: 'M9 2.5h4.5V7M13.5 2.5L8 8M11.5 9.5v3.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3.5',
    back: 'M10 3L5 8l5 5',
    fwd: 'M6 3l5 5-5 5',
    up: 'M3 10.5l5-5 5 5',
    down: 'M3 5.5l5 5 5-5',
    list: 'M2.5 4h11M2.5 8h11M2.5 12h11',
    // a drag handle: two columns of three dots
    grip: 'M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01',
    desk: 'M2 3.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM5.5 13.5h5M8 11.5v2',
  },
};
export default set;
