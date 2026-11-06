// the icon bundle: cached ones at once, the rest read within the budget, the remainder
// listed as missing; a Windows session faked, its probe answering many icons in one go
import "./env.ts";
import { expect, test } from "bun:test";
import { ctxOf, iconKeyOf, icons } from "../src/desk.ts";
import type { Item } from "../src/model.ts";
import type { Session } from "../src/session.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");

// a session whose probe answers an icons request after ms, k: a miss as null
function fake(ms: number, miss = new Set<string>()): Session {
  const s = {
    os: "windows",
    extra: {},
    target: { host: "fakehost" },
    call: (cmd: string, arg: string) =>
      new Promise<string>((res) => {
        if (cmd !== "icons") return res("{}");
        const specs = JSON.parse(arg) as string[];
        setTimeout(() => res(JSON.stringify(specs.map((k) => ({ k, png: miss.has(k) ? null : png })))), ms);
      }),
  } as unknown as Session;
  return s;
}

const item = (icon: string, iv = "1"): Item => ({ name: icon, kind: "file", icon, iv });

test("icons: the budget kept, misses named, the cache answering next time", async () => {
  const host = `icons-${Date.now()}`;
  const s = fake(300, new Set(["f:gone"]));
  const c = ctxOf(s);
  for (const k of ["f:a", "f:b", "f:gone"]) c.icons.add(k);
  const items = [item("f:a"), item("f:b"), item("f:gone"), item("f:never"), item("f:a")];
  // too short a budget: nothing yet, every asked icon missing once
  const first = await icons(s, host, items, 20);
  expect(first.got.size).toBe(0);
  expect(first.missing).toEqual(["f:a\n1", "f:b\n1", "f:gone\n1", "f:never\n1"]);
  // the reads already on their way awaited this time
  const second = await icons(s, host, items, 2000);
  expect([...second.got.keys()].sort()).toEqual(["f:a\n1", "f:b\n1"]);
  expect(second.got.get("f:a\n1")!.type).toBe("image/png");
  expect(second.missing).toEqual(["f:gone\n1", "f:never\n1"]);
  // a spec a session never issued is never read
  const other = await icons(fake(60_000), host, [item("f:a"), item("f:b")], 0);
  expect(other.got.size).toBe(0);
  // cached now: a session whose probe never answers still has them at once
  const quick = fake(60_000);
  for (const k of ["f:a", "f:b"]) ctxOf(quick).icons.add(k);
  const fourth = await icons(quick, host, [item("f:a"), item("f:b")], 0);
  expect([...fourth.got.keys()].sort()).toEqual(["f:a\n1", "f:b\n1"]);
  expect(fourth.missing).toEqual([]);
  expect(iconKeyOf(item("f:a", ""))).toBe("f:a\n");
});
