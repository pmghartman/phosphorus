import "./env.ts";
import { expect, test } from "bun:test";

const { lineTime, logTime } = await import("@phosphorus/server");

test("line time", () => {
  for (const l of ["2026-10-19T21:16:03-0700 [run] up", "[cloudflared] 2026-10-19T21:16:03Z ERR x", "2026/10/19 21:16:03 [frontend] listening"]) {
    expect(lineTime(l)).toBeDefined();
  }
  expect(lineTime("[mesh] couldn't sync")).toBeUndefined();
  // the offset read: both stamps the same instant
  expect(lineTime("2026-10-19T21:16:03-0700 x")!.getTime()).toBe(Date.parse("2026-10-20T04:16:03Z"));
});

test("log time", () => {
  expect(logTime("")).toBeUndefined();
  const t = logTime("30m")!.getTime();
  expect(Math.abs(Date.now() - 30 * 60000 - t)).toBeLessThan(2000);
  expect(logTime("2026-10-19T21:16:03Z")!.toISOString()).toBe("2026-10-19T21:16:03.000Z");
  expect(logTime("2026-10-19 21:16:03")!.getHours()).toBe(21);
  expect(logTime("2026-10-19T21:16")!.getMinutes()).toBe(16);
  expect(logTime("2026-10-19")!.getDate()).toBe(19);
  expect(() => logTime("yesterday")).toThrow("since/until");
});
