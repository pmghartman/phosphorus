// the ssh side against a real sshd: CODE_SSH=user:pass@host:port names a
// login to try, the host one tailscale knows or 127.0.0.1 for this one's
import { expect, test } from "bun:test";

const spec = /^([^:]+):(.*)@([^:@]+)(?::(\d+))?$/.exec(process.env.CODE_SSH ?? "");

test.skipIf(!spec)("ssh: ls, upload, probe and a refused login", async () => {
  const [, user, pass, host, port] = spec!;
  process.env.SELF_HOST = host;
  process.env.HOST_SSH_HOST = host;
  process.env.HOST_SSH_PORT = port ?? "22";
  const { creds, dial, harnessesOn, ls, upload } = await import("../src/index.ts");
  const c = creds({ user, pass });
  const [st, b] = await ls(host!, "~", c);
  expect(st, JSON.stringify(b)).toBe(200);
  expect(b.dir.startsWith("/")).toBe(true);
  expect(Array.isArray(b.entries)).toBe(true);
  expect((await ls(host!, "/nowhere/at/all", c))[0]).toBe(404);
  const name = `phos-ssh-test-${Date.now()}.txt`;
  const body = new TextEncoder().encode("hello over ssh\n");
  const [us, ub] = await upload(host!, "~", name, body.length, body, c);
  expect(us, JSON.stringify(ub)).toBe(200);
  expect(ub.path.endsWith("/" + name)).toBe(true);
  // the same name again lands beside it, never over it
  expect((await upload(host!, "~", name, body.length, body, c))[1].path.endsWith(` (1).txt`)).toBe(true);
  const [hs, hb] = await harnessesOn(host!, c, true);
  expect(hs, JSON.stringify(hb)).toBe(200);
  expect(hb.harnesses.map((h: any) => h.id)).toEqual(["claude", "opencode"]);
  await expect(dial(host!, user!, pass + "-wrong")).rejects.toThrow("refused");
  const cl = await dial(host!, user!, pass!);
  cl.end();
}, 60_000);
