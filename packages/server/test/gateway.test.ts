import "./env.ts";
import { expect, test } from "bun:test";
import type { Ctx } from "@phosphorus/wsock";

const { pageUser } = await import("@phosphorus/server");

const ctx = (headers: Record<string, string> = {}): Ctx => {
  const url = "http://mesh.test/api/model/v1/messages";
  return { req: new Request(url, { method: "POST", headers: { host: "mesh.test", ...headers } }), url: new URL(url), ip: "127.0.0.1", ingress: false, server: undefined as any };
};

// the model gateway's page pass: never without a login, never for another site's page
test("page user refused", () => {
  expect(pageUser(ctx())).toBe(false);
  expect(pageUser(ctx({ origin: "https://elsewhere.test" }))).toBe(false);
});
