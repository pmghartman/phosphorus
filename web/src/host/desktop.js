// Sulfur hosted by the Phosphorus desktop: '#host' in the desktop's page. The desktop's own
// state and helpers, exactly the names of host/contract.js, re-exported as live bindings;
// nothing else of app.js is reachable from Sulfur.
export {
  standalone, ASSETS,
  acct, name, color, selfHost, hostsInfo, dk,
  homeOnline, otherHosts, dkLiveHosts, dkHomeOn, hostUrl, HOME, homeAt, homePick,
  filesApi, filesCall, filesJoin, filesParent, filesWin, putFile, copyFile,
  codeLang, codeKey, codeName, codeTabs, editors, lines, shareMenu, DK_RUNNERS,
  el, esc, cssVar, dkGlyph, colorFor, copyText, humanSize, isMobile, newSid, shQuote, jsonPost,
} from '../app.js';
