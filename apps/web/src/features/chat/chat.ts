import type { UiAction } from '@phosphorus/wire';
import { dkPressed } from '../../desktop/desk.ts';
import './state.ts';
import './lines.ts';
import './convs.ts';
import './menus.ts';
import './files.ts';
import './socket.ts';
import './compose.ts';
import './find.ts';
import './commands.ts';

// the page moved for whoever asked, as a button would: an app, a terminal, a host

export function phosphorusPressed(a: UiAction) {
  if (a) dkPressed(a);
}export { chatName, chatPanel, chatText, colorFor, cwList, joined, send, type ChatLine } from './state.ts';
export { chatNote, fold, lines } from './lines.ts';
export { chatReading, clearUnread, convNow, news, stepConv } from './convs.ts';
export { openConv, setConv } from './files.ts';
export { dragsFiles } from './compose.ts';
export { chatAs, shareMenu } from './commands.ts';
