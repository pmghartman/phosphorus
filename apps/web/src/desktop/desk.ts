import './desk/icons.ts';
import './desk/terminal.ts';
import './desk/wallpaper.ts';
import './desk/windows.ts';
import './desk/webapps.ts';

export const dkView = document.getElementById('view-desktop')!;
export { dkWallClear, dkWallPick, dkWallSet } from '../settings/appearance.ts';
export {
  dkArt,
  dkDesktop,
  dkHostsGone,
  dkIcon,
  dkIconKeys,
  dkIcons,
  dkLayout,
  dkLiveHosts,
  dkLogout,
  dkRoutes,
} from './desk/icons.ts';
export { dkTermApp, dkTermDrop, dkTerminal, dkTermNew, dkTermOn } from './desk/terminal.ts';
export {
  dkArrange,
  dkMenu,
  dkMenuEl,
  dkMenuNote,
  dkService,
  dkWallPaint,
  type MenuItem,
  servicesInTabs,
  WALL_EVENT,
} from './desk/wallpaper.ts';
export { dkWebApp, dkWebApps } from './desk/webapps.ts';
export { dkAppsChanged, dkOpenApp, dkOpenTerminal, dkPressed } from './desk/windows.ts';
