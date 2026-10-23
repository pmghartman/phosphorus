// The boundary between Sulfur and whatever hosts it. Sulfur's code (web/src/sulfur/) and the
// components it shares with the desktop (apps/terminal.js) import their host only as '#host',
// and only these names. The build binds '#host' per page:
//
//   the Phosphorus desktop (index.html)    → host/desktop.js, re-exporting app.js
//   Sulfur on its own (sulfur/index.html)  → sulfur/host.js, this computer offline or a mesh
//
// Both must export every name here; web/tests/host-boundary.test.mjs holds them to it, and
// holds Sulfur to importing nothing of the desktop (app.js, apps/*) but through this list.
// A new need of Sulfur's is added here first, then to both hosts.

export const HOST_API = {
  // where Sulfur runs: null inside the desktop, its mode, window and mesh when alone
  standalone: 'null in the desktop; { mode, app, server, mac, localHost, meshUser, meshUrl, … } when alone',
  ASSETS: 'the page\'s hashed vendor files',

  // who and where: the account, the user's chat name and color, this host and every host's facts
  acct: 'the signed-in account (live binding)',
  name: 'the user\'s display name (live binding)',
  color: 'the user\'s color, \'\' for one picked from the name',
  selfHost: 'the host this page is served from (live binding)',
  hostsInfo: 'every host\'s facts by lowercased name: platform, shell, shares (live binding)',
  dk: 'only dk.creds: host → { user, pass }, the logins this page holds (live binding)',

  // hosts and their APIs
  homeOnline: '() → the hosts holding the merged home that are up',
  otherHosts: '() → hosts reachable beside the home\'s',
  dkLiveHosts: '() → hosts up with a login',
  dkHomeOn: '(host) → whether that host holds the home',
  hostUrl: '(host, path) → the API path that reaches host',
  HOME: 'the merged home\'s files location',
  homeAt: '(host) → one host\'s home location',
  homePick: '(rel) → the host a new file under the home goes to',

  // files
  filesApi: '(loc, op, params) → a files API url',
  filesCall: '(loc, op, init, params) → its JSON, throwing its error',
  filesJoin: '(dir, name) → a joined relative path',
  filesParent: '(path) → its folder',
  filesWin: 'the desktop\'s files window, null alone (live binding)',
  putFile: '(loc, path, body, onSent) → an upload',
  copyFile: '(from, fromPath, to, toPath, tick) → a copy between hosts',

  // the editor's file kinds and open sessions, shared with the desktop's other openers
  codeLang: '(path) → { hl, check, comment } or null',
  codeKey: '(file) → the key of a file\'s editor session',
  codeName: '(file) → its tab\'s name',
  codeTabs: 'Map: codeKey → tab id',
  editors: 'Map: tab id → editor',
  lines: 'Map: a file\'s line to open at',
  shareMenu: '(anchor, file, done) → sharing a file with the mesh\'s people',
  DK_RUNNERS: 'the built-in run commands by extension',

  // small helpers
  el: '(tag, cls, text) → an element',
  esc: '(text) → html-escaped',
  cssVar: '(name) → a root custom property\'s value',
  dkGlyph: '(d, cls) → a 16px svg icon',
  colorFor: '(name) → a person\'s color',
  copyText: '(text) → the clipboard written',
  humanSize: '(bytes) → 1.2m and the like',
  isMobile: '() → a phone\'s layout',
  newSid: '() → a fresh session id',
  shQuote: '(value) → a single-quoted shell word',
  jsonPost: '(body) → fetch options posting it as JSON',
};
export const HOST_NAMES = Object.keys(HOST_API);
