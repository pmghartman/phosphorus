import './desk/icons.ts';
import './desk/apps.ts';
import './desk/wallpaper.ts';
import './desk/windows.ts';
import './desk/webapps.ts';
import './desk/git.ts';

export const dkView = document.getElementById('view-desktop')!;
export { dkTerminal } from './desk/apps.ts';
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
export {
  dkArrange,
  dkMenu,
  dkMenuEl,
  dkMenuNote,
  dkService,
  dkWallClear,
  dkWallPaint,
  dkWallPick,
  dkWallSet,
  type MenuItem,
  WALL_EVENT,
} from './desk/wallpaper.ts';
export { dkSulfurOpen, dkWebApp, dkWebApps } from './desk/webapps.ts';
export { dkAppsChanged, dkOpenApp, dkOpenTerminal, dkPressed } from './desk/windows.ts';
