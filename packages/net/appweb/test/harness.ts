// a loopback harness for one real app: started here as the host would start it, its windows in
// a bare page at http://127.0.0.1:<port>; nothing of phosphorus's own runs
// bun packages/net/appweb/test/harness.ts <exe> [app args...]

import { start } from "../src/launch.ts";
import { localHost } from "../src/local.ts";
import { handle } from "../src/serve.ts";
import { AppWeb } from "../src/session.ts";

const [exe, ...args] = process.argv.slice(2);
if (!exe) throw new Error("usage: harness.ts <exe> [args...]");
const port = Number(process.env.PORT || 7391);

const built = await Bun.build({ entrypoints: [`${import.meta.dir}/harness-page.ts`], target: "browser" });
if (!built.success) throw new AggregateError(built.logs, "harness page build failed");
const pageJs = await built.outputs[0]!.text();
const pageHtml = `<!doctype html><meta charset=utf-8><title>appweb harness</title>
<style>html,body{margin:0;height:100%;background:#334;font:12px system-ui;overflow:hidden}
#desk{position:absolute;inset:0}.win{position:absolute;background:#fff;box-shadow:0 8px 30px #0008;border-radius:6px;overflow:hidden}
.head{height:28px;background:#ddd;display:flex;align-items:center;justify-content:space-between;padding:0 8px}
.body{position:absolute;top:28px;left:0;right:0;bottom:0}
#log{position:fixed;right:0;bottom:0;width:420px;max-height:160px;overflow:auto;margin:0;background:#000c;color:#9f9;font:11px monospace;z-index:99999;pointer-events:none}</style>
<div id=desk></div><pre id=log></pre><script type=module>${pageJs}</script>`;

let app: AppWeb | undefined;
let starting: Promise<AppWeb> | undefined;
const launch = () =>
  (starting ??= (async () => {
    const t0 = performance.now();
    const s = await start(localHost(), exe, args, 30_000);
    console.log(`[harness] app hooked in ${Math.round(performance.now() - t0)}ms, pid ${s.pid}`);
    s.proc.onErr((b) => {
      for (const l of Buffer.from(b).toString("utf8").split("\n"))
        if (l.includes("[phosphorus]") || process.env.ALLERR) console.log(l);
    });
    app = new AppWeb("harness", exe, s.link, s.token, s.proc);
    app.onEnd = (why) => {
      console.log(`[harness] app ended: ${why}`);
      process.exit(0);
    };
    return app;
  })());

Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(pageHtml, { headers: { "Content-Type": "text/html" } });
    if (url.pathname === "/ws") {
      const q = url.searchParams;
      return srv.upgrade(req, {
        data: { w: Number(q.get("w")) || 1600, h: Number(q.get("h")) || 900, dpr: Number(q.get("dpr")) || 1 } as never,
      })
        ? undefined
        : new Response("no", { status: 400 });
    }
    const r = await handle(req, url, "/api/appweb", `http://${url.host}`);
    if (r) {
      if (process.env.TRACE) console.log(req.method, url.pathname.slice(0, 160), r.status);
      return r;
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    async open(ws) {
      const d = ws.data as any;
      const viewer = {
        binary: (b: Uint8Array) => void ws.sendBinary(b),
        json: (v: unknown) => void ws.sendText(JSON.stringify(v)),
        queued: () => ws.getBufferedAmount(),
        close: (c?: number) => ws.close(c),
      };
      d.viewer = viewer;
      try {
        const a = await launch();
        d.app = a;
        await a.attach(viewer, { w: d.w, h: d.h, dpr: d.dpr, dark: true }, `http://127.0.0.1:${port}/api/appweb`);
      } catch (e) {
        console.error("[harness]", e);
        ws.sendText(JSON.stringify({ t: "error", s: String(e) }));
      }
    },
    message(ws, m) {
      const d = ws.data as any;
      if (typeof m !== "string") d.app?.fromViewer(new Uint8Array(m as Buffer));
    },
    close(ws) {
      const d = ws.data as any;
      d.app?.detach(d.viewer);
    },
  },
});
console.log(`[harness] http://127.0.0.1:${port}`);
