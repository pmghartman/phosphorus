// smoke test as root on a real Linux host, off the mesh's range: ping answered through a throwaway
// tunnel, then gone on close; sudo bun packages/net/tun/test/smoke.ts [name] [ip] [prefix]
import { open } from "../src/index.ts";
import { echoReply } from "./icmp.ts";

const [name = "phostest0", ip = "10.250.0.1", prefix = "10.250.0.0/24"] = process.argv.slice(2);
const far = ip.replace(/\.\d+$/, (m) => `.${(Number(m.slice(1)) % 254) + 1}`);

const sh = async (...argv: string[]) => {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, text: (out + err).trim() };
};
let bad = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "fail"} ${what}`);
  if (!ok) bad++;
};

if (process.platform !== "linux") throw new Error("this smoke test is for linux");
const tun = await open({ name, ip, prefix });
check(tun.name === name, `opened ${tun.name}`);
const addr = await sh("ip", "-br", "addr", "show", "dev", tun.name);
console.log("     " + addr.text);
check(addr.text.includes(`${ip}/32`) && /\bUP\b|UNKNOWN/.test(addr.text), "address set, link up");
const link = await sh("ip", "link", "show", "dev", tun.name);
check(link.text.includes("mtu 1280"), "mtu 1280");
const route = await sh("ip", "route", "show", prefix);
console.log("     " + route.text);
check(route.text.includes(`dev ${tun.name}`), `route ${prefix} through ${tun.name}`);

let requests = 0,
  other = 0;
const answering = (async () => {
  for (;;) {
    const p = await tun.read();
    const r = echoReply(p);
    if (!r) {
      other++;
      continue;
    }
    requests++;
    check(tun.write(r), `echo reply ${requests} written`);
  }
})().catch((e: Error) => e);

const ping = await sh("ping", "-c", "3", "-W", "2", "-I", tun.name, far);
console.log(ping.text.split("\n").slice(-2).join("\n"));
check(ping.code === 0, `ping ${far} answered through the tunnel`);
check(requests >= 3, `${requests} echo requests read (${other} other packets)`);

const t = performance.now();
await tun.close();
check(performance.now() - t < 1500, `closed in ${Math.round(performance.now() - t)}ms`);
const ended = await answering;
check(ended instanceof Error && /closed/.test(ended.message), "a pending read ended by close");
check(!tun.write(new Uint8Array([0x45])), "no writes after close");
const gone = await sh("ip", "link", "show", "dev", tun.name);
check(gone.code !== 0, `${tun.name} gone`);

console.log(bad ? `${bad} check(s) failed` : "all good");
process.exit(bad ? 1 : 0);
