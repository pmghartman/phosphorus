// the page's entry: the desktop and its apps, one bundle
// the leaves first: markdown, the themes and the icons; then the
// modules of one strongly connected graph whose top-level code touches only the leaves,
// the DOM and hoisted functions
import './md.ts';
import './theme.ts';
import './icons.ts';
import './games.ts';
import './mesh.ts';
import './shares.ts';
import './notes.ts';
import { setConv } from './chat.ts';
import './update.ts';
import './sync.ts';
import './scheme.ts';
import './keys/shortcuts.ts';
import './desktop/windows.ts';
import './desktop/taskbar.ts';
import './desktop/login.ts';
import './desktop/desk.ts';
import './desktop/deskfiles.ts';
import './desktop/control.ts';
import './desktop/switcher.ts';
import './desktop/spotlight.ts';
import './desktop/keys.ts';
import './desktop/session.ts';
import { acctStart } from './account.ts';
import './mcp.ts';
import './agent.ts';

// the chat on #mesh from the start, once every module is up (app.js ran it at the end of its
// chat section; here after the notes it reads have loaded)
setConv('mesh');
acctStart();
