// what differs by platform: the resize and quit signals
const win = process.platform === "win32";

// no resize signal on Windows: the size polled by the loop's tick
export const sigResize: NodeJS.Signals | undefined = win ? undefined : "SIGWINCH";
export const quitSignals: NodeJS.Signals[] = win ? ["SIGINT", "SIGTERM"] : ["SIGTERM", "SIGHUP"];
