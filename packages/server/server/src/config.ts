// the frontend's environment, this host's platform and the few constants
// every route file shares
import { join } from "node:path";
import { readVersion, uuid, VersionFile } from "@phosphorus/update";
import { env, envInt, logf, readJSONMap, StateDir, writeJSONAtomic } from "@phosphorus/util";

export const port = envInt("FRONTEND_PORT", 8090);
export const ingressPort = envInt("INGRESS_PORT", 80);
export const stateDir = StateDir;
export const selfHost = process.env.SELF_HOST ?? "";
export const baseDomain = process.env.BASE_DOMAIN ?? "";
export const hostSSHHost = env("HOST_SSH_HOST", "127.0.0.1");
export const hostSSHPort = env("HOST_SSH_PORT", "22");
export const adminPass = env("ADMIN_PASS", process.env.PHOSPHORUS_UPDATE_PASSWORD ?? "");
export const tsAPIKey = process.env.TS_API_KEY ?? "";

export const platformFile = join(stateDir, "platform.json");
export const gameKeyDir = join(stateDir, "game-control");
export const bootID = uuid();
// the key the frontend ssh's with: a copy kept apart from the user's
// profile, under state on Windows where /root doesn't exist
export const gameKey = process.platform === "win32" ? join(gameKeyDir, "run-key") : "/root/.ssh/game-control";

export const runMS = 12 * 3600 * 1000;
export const runSandbox = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads";
export const maxTerms = 16;
// modelColor the colour of lines a key's agent posts
export const modelColor = "#d2a8ff";
// whoHeader a keyed caller's home rights, sealed for a peer's files call
export const whoHeader = "X-Phosphorus-Who";

let updating = false;
export const isUpdating = () => updating;
export const setUpdating = (on: boolean) => void (updating = on);

// Version this binary's release, the image's VERSION
export const Version = () => readVersion(VersionFile) || "0.0.0";

let platform = "";
export const getPlatform = () => platform;
export const setPlatform = (p: string) => void (platform = p);

export const selfInfo = () => ({ host: selfHost, version: Version(), platform: getPlatform(), bootId: bootID });

export const detectPlatform = () => (process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "windows" : "linux");

export function recordPlatform() {
  const found = detectPlatform();
  platform = found;
  try {
    writeJSONAtomic(platformFile, { platform: found });
  } catch {}
  logf("[frontend] running on %s", found);
}

// the platform of the last run, until this one's is recorded
export function loadPlatform() {
  const p = readJSONMap(platformFile)?.platform;
  if (typeof p === "string") platform = p;
}
