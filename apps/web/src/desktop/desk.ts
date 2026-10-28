import './desk/icons.ts';
import './desk/apps.ts';
import './desk/wallpaper.ts';
import './desk/windows.ts';
import './desk/webapps.ts';
import './desk/git.ts';

export const dkView = document.getElementById('view-desktop')!;export { dkArt, dkDesktop, dkHostsGone, dkIcon, dkIconKeys, dkIcons, dkLayout, dkLiveHosts, dkLogout, dkRoutes } from './desk/icons.ts';
export { dkTerminal } from './desk/apps.ts';
export { WALL_EVENT, dkArrange, dkMenu, dkMenuEl, dkMenuNote, dkService, dkWallClear, dkWallPaint, dkWallPick, dkWallSet, type MenuItem } from './desk/wallpaper.ts';
export { dkAppsChanged, dkOpenApp, dkOpenTerminal, dkPressed } from './desk/windows.ts';
export { dkSulfurOpen, dkWebApp, dkWebApps } from './desk/webapps.ts';
