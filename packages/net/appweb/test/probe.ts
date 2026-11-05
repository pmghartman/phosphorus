// scratch: launch local VS Code isolated, print what the hook says
import { codec, Op, Reader, wire } from "../src/frames.ts";
import { start } from "../src/launch.ts";
import { localHost } from "../src/local.ts";
const tmp = process.env.PHX_TMP!;
const exe = "C:/Program Files/Microsoft VS Code/Code.exe";
const s = await start(localHost(), exe, [`--user-data-dir=${tmp}/ud`, `--extensions-dir=${tmp}/ext`, "--disable-gpu", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"], 20000);
console.log("hooked pid", s.pid);
const names = Object.fromEntries(Object.entries(Op).map(([k, v]) => [v, k]));
new Reader((f) => {
  const h = codec.head(f);
  let b: any; try { b = codec.body(f); } catch (e) { b = String(e); }
  const t = JSON.stringify(b, (k, v) => (k === "env" ? "[env]" : k === "text" ? `[${String(v).length}b]` : v));
  console.log(names[h.op], h.wc, h.id, t?.slice(0, 400));
}).push.bind;
const r = new Reader((f) => {
  const h = codec.head(f);
  let b: any; try { b = codec.body(f); } catch (e) { b = String(e); }
  const t = JSON.stringify(b, (k, v) => (k === "env" ? "[env]" : k === "text" ? `[${String(v).length}b]` : v));
  console.log(names[h.op], h.wc, h.id, t?.slice(0, 400));
});
s.link.onData((b) => r.push(b));
s.link.onClose(() => console.log("link closed"));
s.link.write(wire(codec.frame(Op.hello, 0, 0, { token: s.token, viewer: { w: 1600, h: 900, dpr: 1, dark: true } })));
await Bun.sleep(8000);
console.log("--- app log tail:\n", s.log().slice(-1500));
s.proc.close();
process.exit(0);
