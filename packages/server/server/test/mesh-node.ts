// one host of a test mesh: the whole server on its own loopback address, and a
// control endpoint the harness drives it through; started by harness.ts
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as files from "@phosphorus/files";
import { allTools } from "@phosphorus/mcp";
import * as peers from "@phosphorus/peers";
import { runningApps, start } from "@phosphorus/server";
import * as store from "@phosphorus/store";
import * as webapps from "@phosphorus/webapps";

const srv = await start();

const view = () => ({
  tailnet: peers.tailnet(),
  routes: peers.routes(),
  peerGit: peers.peerGit(),
  peerModel: peers.peerModel(),
  lock: peers.lock(),
  chain: peers.chain(),
  peerIPs: peers.peerIPs(),
  links: peers.links(),
  offline: peers.offlineMS(),
});

Bun.serve({
  hostname: process.env.FRONTEND_BIND,
  port: Number(process.env.CTL_PORT),
  async fetch(req) {
    const a = (await req.json()) as Record<string, any>;
    switch (a.op) {
      case "view":
        return Response.json(view());
      case "store.write":
        store.write(a.rel, a.data);
        return Response.json({ ok: true });
      case "store.remove":
        store.remove(a.rel);
        return Response.json({ ok: true });
      case "store.read":
        return Response.json({ data: store.read(a.rel) ?? null });
      case "store.digest":
        return Response.json({ digest: store.digest() });
      case "store.stamps":
        return Response.json(store.stamps());
      case "store.merge":
        return Response.json({ changed: store.merge(a.files) });
      case "store.prune":
        store.prune();
        return Response.json({ ok: true });
      case "clock.skew":
        store.setClockSkew(a.ms);
        return Response.json({ ok: true });
      case "link.drop":
        peers.dropLink(a.host);
        return Response.json({ ok: true });
      case "app.install":
        return Response.json(await webapps.Install(a.id));
      case "app.running":
        return Response.json(runningApps());
      case "tool": {
        const t = allTools().find((x) => x.name === a.name);
        if (!t) return Response.json({ error: `no tool ${a.name}` }, { status: 404 });
        const caller = { user: a.user, admin: false, via: "test" };
        return Response.json(await t.run(a.args ?? {}, { caller, local: false }));
      }
      case "home.write":
        await Bun.write(join(files.HomeRoot, a.rel), a.text);
        return Response.json({ ok: true });
      case "home.delete":
        rmSync(join(files.HomeRoot, a.rel), { force: true });
        return Response.json({ ok: true });
      case "home.read": {
        const abs = join(files.HomeRoot, a.rel);
        return Response.json({ text: existsSync(abs) ? readFileSync(abs, "utf8") : null });
      }
    }
    return new Response("no such op", { status: 400 });
  },
});
console.log(`ready ${srv.port}`);
