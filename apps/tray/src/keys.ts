// the keys form in the browser, served by the tray on this machine alone behind
// a random path: which keys are set, never their values; the typed ones into .env
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Default, load, type Tokens } from "@phosphorus/theme";
import keysHtml from "../assets/keys.html" with { type: "file" };
import { frontendURL, hostCmd, keyState, keyStatus, keysMissing } from "./host.ts";

// the form in the theme library's colors, the mesh's own, light or dark as the system is
function keysTheme(): string {
  const lib = load();
  const vars = (t: Tokens) =>
    `--bg: ${t["--bg"]}; --fg: ${t["--fg"]}; --muted: ${t["--muted"]}; --line: ${t["--border"]}; --field: ${t["--card"]}; --accent: ${t["--accent"]}; --ok: ${t["--online"]}; --bad: ${t["--offmesh"]};`;
  return `:root { ${vars(lib.tokens(Default, "light"))} }\n  @media (prefers-color-scheme: dark) { :root { ${vars(lib.tokens(Default, "dark"))} } }`;
}

const keysPage = () => readFileSync(keysHtml as unknown as string, "utf8").replace("/*theme*/", keysTheme());

const reply = (status: number, v: unknown) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });

let srv: { base: string; done: boolean; err: string } | undefined;

// the form's address, its server started on first use; start (re)starts phosphorus
// on saved keys and gives its error, "" when up
export function keysURL(start: () => Promise<string>): string {
  if (srv) return srv.base;
  const tok = "/" + randomBytes(16).toString("hex") + "/";
  const page = keysPage();
  let host = "";
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      // by this address alone, never a rebound name, and never posted to by a page elsewhere
      const o = req.headers.get("origin");
      if (req.headers.get("host") !== host || (o && o !== "http://" + host))
        return new Response("forbidden", { status: 403 });
      const path = new URL(req.url).pathname;
      if (!path.startsWith(tok)) return new Response("not found", { status: 404 });
      switch (path.slice(tok.length)) {
        case "":
          return new Response(page, {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        case "status":
          return reply(200, await keyStatus());
        case "save":
          return saveKeys(req, start);
        case "started": {
          const st: Record<string, string> = {};
          if (srv!.done && srv!.err) st.error = srv!.err;
          else if (srv!.done) st.url = frontendURL((await keyState()).domain);
          return reply(200, st);
        }
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  host = `127.0.0.1:${s.port}`;
  srv = { base: "http://" + host + tok, done: false, err: "" };
  return srv.base;
}

// the typed keys into .env, blanks keeping what's there, then phosphorus started on them
async function saveKeys(req: Request, start: () => Promise<string>): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "post" });
  let values: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 64 << 10) throw new Error("too long");
    values = JSON.parse(text).values ?? {};
  } catch {
    return reply(400, { error: "bad request" });
  }
  let body = "";
  for (const [k, raw] of Object.entries(values)) {
    const v = String(raw ?? "").replace(/\s+/g, "");
    if (!v || !/^[A-Z_]+$/.test(k)) continue;
    body += `${k}=${v}\n`;
  }
  if (!body) {
    if (await keysMissing()) return reply(400, { error: "the Tailscale auth key is needed" });
    return reply(200, { starting: false });
  }
  const r = await hostCmd(["keys", "--stdin"], body);
  if (!r.ok) return reply(400, { error: r.output.trim() || r.error || "keys failed" });
  if (await keysMissing()) return reply(400, { error: "the Tailscale auth key is needed" });
  srv!.done = false;
  srv!.err = "";
  start().then((e) => {
    srv!.done = true;
    srv!.err = e;
  });
  return reply(200, { starting: true });
}
