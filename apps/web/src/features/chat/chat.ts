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
}
export { chatAs, shareMenu } from './commands.ts';
export { dragsFiles } from './compose.ts';
export { chatReading, clearUnread, convNow, news, stepConv } from './convs.ts';
export { openConv, setConv } from './files.ts';
export { chatNote, fold, lines } from './lines.ts';
export { type ChatLine, chatName, chatPanel, chatText, colorFor, cwList, joined, send } from './state.ts';
