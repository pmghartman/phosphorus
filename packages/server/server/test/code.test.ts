import "./env.ts";
import { expect, test } from "bun:test";

const store = await import("@phosphorus/store");
const users = await import("@phosphorus/users");
const { marshal } = await import("@phosphorus/util");
const { codeBlocked, codeBlockedMsg, codeLogin, codeOptions } = await import("@phosphorus/server");

// the options for a user whose vault holds no host login: none offered, blocked
test("code options blocked", async () => {
  const key = users.Derive("pw", "00").subarray(32);
  const put = (hosts: Record<string, any>) =>
    store.write("home/pmh/vault.json", users.Seal(key, marshal({ hosts, pages: {} })));
  const s: import("@phosphorus/users").Session = { user: "pmh", admin: false, boot: false, key, token: "", e: 0 };
  put({});
  let o = await codeOptions(s);
  expect(o.hosts).toEqual([]);
  expect(o.blocked).toBe(codeBlockedMsg);
  expect(await codeBlocked(s)).toBe(codeBlockedMsg);
  await expect(codeLogin(s, "razer")).rejects.toThrow("no saved login for razer");
  put({ razer: { user: "pmh", pass: "x" } });
  o = await codeOptions(s);
  expect(o.hosts).toEqual(["razer"]);
  expect(o.blocked).toBeUndefined();
  const c = await codeLogin(s, "razer");
  expect([c.user, c.pass]).toEqual(["pmh", "x"]);
  // another password's key opens nothing
  expect(await codeBlocked({ ...s, key: users.Derive("other", "00").subarray(32) })).not.toBe("");
});
