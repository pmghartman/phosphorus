// the page's entry: the desktop and its apps, one bundle
// the leaves first: markdown, the themes and the icons; then the
// modules of one strongly connected graph whose top-level code touches only the leaves,
// the DOM and hoisted functions
import './lib/md.ts';
import './lib/theme.ts';
import './lib/icons.ts';
import './features/games.ts';
import './features/mesh/mesh.ts';
import './features/home/home.ts';
import './features/notes.ts';
import { setConv } from './features/chat/chat.ts';
import './features/update.ts';
import './lib/sync.ts';
import './lib/scheme.ts';
import './desktop/shortcuts.ts';
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
import { acctStart } from './features/account.ts';
import './features/mcp.ts';
import './features/agent.ts';

// the chat on #mesh from the start, once every module is up (app.js ran it at the end of its
// chat section; here after the notes it reads have loaded)
setConv('mesh');
acctStart();
