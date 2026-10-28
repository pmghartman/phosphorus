// phosphorus: one binary for every role, run's children (serve | model | elector |
// cli), the host's (install, start, stop, keys and the rest) and, on macOS and
// Windows, the menu bar or tray app (tray)
import { main as cliMain } from "@phosphorus/cli";
import { main as electorMain } from "@phosphorus/elector";
import { commands, main as hostMain, version } from "@phosphorus/host";
import { main as modeldMain } from "@phosphorus/modeld";
import { serve } from "@phosphorus/server";
import { setLogStamps } from "@phosphorus/util";

const [cmd = "", ...args] = process.argv.slice(2);

// role run's children: the frontend, the model, the git elector
async function role(cmd: string): Promise<number | undefined> {
  // each line timed where the log is run's file, journald timing it on Linux
  setLogStamps(process.platform !== "linux");
  switch (cmd) {
    case "serve":
      return serve();
    case "model":
      return modeldMain();
    case "elector":
      return electorMain();
  }
  return undefined;
}

// the app: `tray`, or Phosphorus.app opened on macOS, which passes no command (or
// the login item's --background); its module runs on import
const inBundle = process.platform === "darwin" && /\.app\/Contents\/MacOS\//.test(process.execPath);
if (cmd === "tray" || (inBundle && (cmd === "" || cmd.startsWith("--")))) await import("@phosphorus/tray-app");
else if (cmd === "cli") process.exit(await cliMain(args));
else if (cmd === "version") console.log(version());
else if (commands.has(cmd)) process.exit(await hostMain(cmd, args));
else {
  const code = await role(cmd);
  if (code !== undefined) process.exit(code);
  console.error("usage: phosphorus [start | stop | restart | update [all] | keys | help]");
  process.exit(2);
}
