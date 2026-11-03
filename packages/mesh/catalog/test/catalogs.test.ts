import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { casaos } from "../src/adapters/casaos.ts";
import { runtipi } from "../src/adapters/runtipi.ts";
import { all, refresh, search, setup, sources } from "../src/catalogs.ts";
import { tarball } from "./helpers.ts";

const root = mkdtempSync(join(tmpdir(), "phos-catalog-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// a codeload stand-in: each catalogue's fixture under an ETag, or down
let down = false;
const asked: { url: string; headers: Record<string, string> }[] = [];
setup({
  root,
  url: (a) => `https://codeload.test/${a.id}`,
  fetch: async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    asked.push({ url, headers });
    if (down) throw new Error("connection refused");
    const id = url.split("/").pop()!;
    const etag = `"${id}-1"`;
    if (headers["If-None-Match"] === etag) return new Response(null, { status: 304 });
    return new Response(tarball(id), { headers: { ETag: etag } });
  },
});

beforeEach(() => {
  asked.length = 0;
  down = false;
});

test("fetched once, cached, asked again with its ETag", async () => {
  await refresh(casaos);
  expect(asked.length).toBe(1);
  const s = sources().find((s) => s.id === "casaos")!;
  expect(s).toMatchObject({ apps: 1, licence: "Apache-2.0", repo: "https://github.com/IceWhaleTech/CasaOS-AppStore" });
  expect(s.fetchedAt).toBeGreaterThan(0);
  // within the day: not asked
  asked.length = 0;
  await refresh(casaos);
  expect(asked.length).toBe(0);
  // forced: asked with the ETag, the 304 keeping the copy
  await refresh(casaos, true);
  expect(asked[0]!.headers["If-None-Match"]).toBe('"casaos-1"');
  expect(sources().find((s) => s.id === "casaos")!.apps).toBe(1);
});

test("a failed fetch keeps the last good copy, with the error", async () => {
  down = true;
  await refresh(casaos, true);
  const s = sources().find((s) => s.id === "casaos")!;
  expect(s.apps).toBe(1);
  expect(s.error).toContain("connection refused");
  down = false;
  await refresh(casaos, true);
  expect(sources().find((s) => s.id === "casaos")!.error).toBeUndefined();
});

test("ids unique across sources; search over name, tagline and category", async () => {
  await refresh(runtipi);
  const ids = all().map((d) => `${d.source}:${d.id}`);
  // both have a "demo": the later source's is prefixed
  expect(ids).toContain("casaos:demo");
  expect(ids).toContain("runtipi:runtipi-demo");
  expect(new Set(all().map((d) => d.id)).size).toBe(all().length);
  expect(search({ q: "database" }).map((d) => d.ref)).toEqual(["demo"]);
  expect(search({ q: "demo", source: "casaos" }).map((d) => d.name)).toEqual(["Demo App"]);
  expect(search({ category: "media" }).map((d) => d.ref)).toEqual(["v2only"]);
});
