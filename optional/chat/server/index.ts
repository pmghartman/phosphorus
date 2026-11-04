// the mesh chat's server half: the socket every browser joins, attachments sent
// and fetched, the lines and who's on across every host, and its MCP tools
import { join } from "node:path";
import type { AppContext } from "@phosphorus/app-sdk";
import { start } from "./log.ts";
import { media, valid } from "./media.ts";
import { mesh } from "./mesh.ts";
import { onChat } from "./socket.ts";
import { tools } from "./tools.ts";

const mediaRe = /^\/media\/([a-z0-9][a-z0-9-]*)\/([0-9a-f]{32})$/;

export function register(ctx: AppContext) {
  const files = media(join(ctx.dataDir, "media"), ctx.log);
  const log = start(ctx);
  const m = mesh(ctx);

  ctx.socket("/ws", onChat);

  ctx.route("POST", "/upload", (r) =>
    files.save(ctx.host, r.req, r.query.get("name") ?? "", r.query.get("type") ?? ""),
  );

  // an attachment, from its own host on first view
  ctx.route("GET", "/media/*", async (r) => {
    const at = mediaRe.exec(r.path);
    if (!at || !valid(at[1]!, at[2]!)) return [404, { error: "no such attachment" }];
    const [, host, id] = at as unknown as [string, string, string];
    const dl = r.query.has("dl");
    const held = files.serve(host, id, dl);
    if (held) return held;
    if (host === ctx.host) return [404, { error: "no such attachment" }];
    const got = await files.pull(host, id, () => ctx.peerFetch(host, `/media/${host}/${id}`));
    return (got && files.serve(host, id, dl)) || [502, { error: `${host} has it and isn't answering` }];
  });
  // another host's pull, of what's held here
  ctx.route(
    "GET",
    "/media/*",
    (r) => {
      const at = mediaRe.exec(r.path);
      return (at && files.serve(at[1]!, at[2]!, false)) || [404, { error: "no such attachment" }];
    },
    { internal: true },
  );

  ctx.tools(tools());
  ctx.onStop(() => {
    m.stop();
    log.stop();
  });
}
