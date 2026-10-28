// one host of a test mesh: the whole server on its own loopback address, and a
// control endpoint the harness drives it through; started by harness.ts
import * as peers from "@phosphorus/peers";
import { mergedChat, postOwn, start } from "@phosphorus/server";
import * as store from "@phosphorus/store";

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
      case "chat.post":
        return Response.json({ seq: postOwn({ name: a.name, color: "#aabbcc", text: a.text }).seq });
      case "chat.lines":
        return Response.json(mergedChat.map((m) => ({ host: m.host, seq: m.seq, text: m.text })));
    }
    return new Response("no such op", { status: 400 });
  },
});
console.log(`ready ${srv.port}`);
