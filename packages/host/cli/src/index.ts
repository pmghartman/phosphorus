// the terminal ui (phos) and the config edits it shares with the frontend
export { keys, main } from "./cli.ts";
export { configText, editIni, editService, IniKeys, lineDiff, setIni, setService } from "./config.ts";
export { startDetached } from "./sys.ts";
