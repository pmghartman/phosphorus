// phosphorus's own apps' icons, built into the binary from optional/<id>/web/static: the running
// version's own, shown before any host serves the app, never fetched or kept
import chat from "../../../../optional/chat/web/static/icon.svg" with { type: "file" };
import code from "../../../../optional/code/web/static/icon.svg" with { type: "file" };
import games from "../../../../optional/games/web/static/icon.svg" with { type: "file" };
import viewer from "../../../../optional/viewer/web/static/icon.svg" with { type: "file" };

const own: Record<string, string> = { chat, code, games, viewer };

// an app's icon as this build carries it, none for an app it doesn't
export async function AppIcon(id: string): Promise<{ data: Uint8Array; type: string } | undefined> {
  const f = own[id];
  if (!f) return;
  try {
    return { data: new Uint8Array(await Bun.file(f).arrayBuffer()), type: "image/svg+xml" };
  } catch {
    return;
  }
}
