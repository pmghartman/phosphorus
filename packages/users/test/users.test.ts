import { expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Req, Session } from "@phosphorus/users";

process.env.HOME_FS = mkdtempSync(join(tmpdir(), "phos-users-"));
process.env.BASE_DOMAIN = "mesh.example";
process.env.SELF_HOST = "tshost";
process.env.ADMIN_PASS = "bootpw";
const sysfs = await import("@phosphorus/sysfs");
// the tree, secret and tokens the Go package wrote, loaded before any MeshKey
const testdata = join(import.meta.dir, "testdata");
cpSync(join(testdata, "go-sys"), sysfs.Root, { recursive: true });
sysfs.loadTree();
const U = await import("@phosphorus/users");
const fx = (await Bun.file(join(testdata, "go-fixture.json")).json()) as Record<string, any>;
const { marshal } = await import("@phosphorus/util");

const req = (headers: Record<string, string> = {}, url = "https://mesh.example/api/x", ip = "127.0.0.1"): Req => ({
  req: new Request(url, { headers }),
  url: new URL(url),
  ip,
});
const hex = (b: Uint8Array | undefined) => Buffer.from(b ?? []).toString("hex");
const tokenOf = (cookie: string) => /^phosphorus-user=([^;]+)/.exec(cookie)![1]!;
const sent = (cookie: string) => req({ cookie: "phosphorus-user=" + tokenOf(cookie) });

// the fixture's cookie and keys as of when Go made them
async function atFixtureTime<T>(fn: () => T | Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => fx.at;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

// vectors recorded from Node's crypto (scrypt defaults, aes-256-gcm)
const vecSalt = "00112233445566778899aabbccddeeff";
const vecPass = "hunter2 ünï";
const vecOut = "8c86694dfb3f9a13c8f4068192ad0ddaf52fe9bbcd03d2a578ed68ca0fc79eb37579bc061fc2e5c5209ea0c8099bec46821efcfd5231b68850c6af01ec7f0a04";
const vecText = `{"hosts":{},"pages":{}} ✓`;
const vecBox = { iv: "0102030405060708090a0b0c", tag: "d94ae642cf96f284c42501cd55dbf86f", data: "tG5xYqWZD7fplRlMOuSspjXD2htU2GVVnEm9" };

test("derive matches node", () => {
  expect(hex(U.Derive(vecPass, vecSalt))).toBe(vecOut);
});

test("open node box", () => {
  const out = Buffer.from(vecOut, "hex");
  expect(U.Open(out.subarray(32), vecBox)).toBe(vecText);
  expect(U.Open(out.subarray(0, 32), vecBox)).toBeUndefined();
});

test("seal round trip", () => {
  const key = Buffer.from(vecOut, "hex").subarray(32);
  const b = U.Seal(key, vecText);
  expect(U.Open(key, b)).toBe(vecText);
  expect(U.Open(key, { ...b, tag: (b.tag[0] === "0" ? "1" : "0") + b.tag.slice(1) })).toBeUndefined();
});

test("b64url", () => {
  expect(Buffer.from(U.B64URL("eyJhIjoiw6k_PiJ9")!).toString()).toBe(`{"a":"é?>"}`);
  expect(Buffer.from(U.B64URL("eyJhIjoiw6k/PiJ9==")!).toString()).toBe(`{"a":"é?>"}`);
  expect(U.B64URL("not base64!")).toBeUndefined();
});

test("go's files, keys and tokens open as they are", async () => {
  // the shadow record: Go's scrypt hash of the password, the vault key its other half
  const sh = sysfs.read("etc/shadow/pmh.json");
  const out = U.Derive(fx.pass, sh.salt);
  expect(hex(out.subarray(0, 32))).toBe(sh.hash);
  expect(hex(out.subarray(32))).toBe(fx.sessionKey);
  // the mesh secret as Go hashed it, a box it sealed
  expect(hex(U.MeshKey())).toBe(fx.meshKey);
  expect(U.Open(U.MeshKey(), fx.box)).toBe("hello ✓ <&>");
  await atFixtureTime(async () => {
    // the login cookie
    const c = req({ cookie: `other=1; phosphorus-user=${fx.token}` });
    const s = U.Of(c)!;
    expect(s).toBeDefined();
    expect([s.user, s.admin, s.boot, hex(s.key)]).toEqual(["pmh", true, false, fx.sessionKey]);
    expect(U.Pass(c)).toBe(true);
    expect(U.Issuers(c)).toEqual(["gohost"]);
    expect(await U.Soon(c)).toEqual(s);
    // the vault, prefs and token it sealed
    const me = await U.Me(s);
    expect(me.vault).toEqual({ hosts: { razer: { user: "pmh", pass: "x" } }, pages: { forge: { url: "https://forge.example", user: "u", pass: "p" } } });
    expect([me.vaultOK, me.prefs, me.user, me.admin, me.boot, me.wallpaper]).toEqual([true, { theme: "dark" }, "pmh", true, false, 0]);
    expect(me.prefsAt).toBe(sysfs.stamp("home/pmh/prefs.json"));
    expect(await U.AnthropicToken(s)).toBe("sk-ant-oat01-abc_DEF-123");
    expect(await U.HostLogin(s, "razer")).toEqual(["pmh", "x", true]);
    expect(await U.PageLogin(s, "nope", "forge.example")).toEqual(["u", "p", true]);
    // a grant and the mcp key, its boxes under the secret the key holds
    expect(U.OpenGrant(fx.grant)?.x).toBe("y");
    const [ks, why] = U.CheckMCPKey(fx.mcpKey);
    expect([ks?.user, ks?.admin, why]).toEqual(["pmh", true, ""]);
    expect(U.MCPLogins(fx.mcpKey)).toEqual({ razer: { user: "pmh", pass: "x" } });
    expect(U.MCPPages(fx.mcpKey)?.forge?.url).toBe("https://forge.example");
    expect(U.MCPLogin(fx.mcpKey, "razer")).toEqual(["pmh", "x", true]);
    // the key in use sealed again: same generation, same url
    const o = await U.MCPURL(s, undefined, c);
    expect([o.status, o.body.fresh, o.body.hosts, o.body.pages]).toEqual([200, false, ["razer"], ["forge"]]);
    expect(U.OpenGrant(o.body.key)?.m).toBe(U.OpenGrant(fx.mcpKey)?.m);
    expect(o.body.url.startsWith("https://mesh.example/api/mcp/")).toBe(true);
    expect([U.HasMCPKey("pmh"), U.Exists("pmh"), U.IsAdmin("pmh"), await U.Setup()]).toEqual([true, true, true, false]);
  });
  // the cookie expired: 30 days
  const real = Date.now;
  Date.now = () => fx.at + 31 * 24 * 3600 * 1000;
  try {
    expect(U.Of(req({ cookie: `phosphorus-user=${fx.token}` }))).toBeUndefined();
  } finally {
    Date.now = real;
  }
  expect(U.CheckMCPKey("")[1]).toBe("missing");
  expect(U.CheckMCPKey("xx")[1]).toBe("malformed, or sealed by another mesh");
});

test("login issues a cookie this package and go read alike", async () => {
  const c = req({ host: "mesh.example", "x-forwarded-proto": "https" });
  const o = await U.Login({ user: " PMH ", pass: fx.pass }, c);
  expect(o.status).toBe(200);
  expect(o.body.vault.hosts.razer.user).toBe("pmh");
  const cookie = o.cookie![0]!;
  expect(cookie.endsWith("; Max-Age=2592000; Path=/; Domain=mesh.example; SameSite=Lax; HttpOnly; Secure")).toBe(true);
  // the token's envelope, as Issuers and the Go side read it
  const env = JSON.parse(Buffer.from(U.B64URL(tokenOf(cookie))!).toString());
  expect(Object.keys(env).sort()).toEqual(["data", "h", "iv", "tag"]);
  expect(env.h).toBe("tshost");
  const s = U.Of(sent(cookie))!;
  expect([s.user, hex(s.key)]).toEqual(["pmh", fx.sessionKey]);
  expect(U.Issuers(sent(cookie))).toEqual([]);
  expect(U.ClearCookie(c)).toEqual(["phosphorus-user=; Max-Age=0; Path=/; Domain=mesh.example; SameSite=Lax; HttpOnly; Secure"]);
  expect(U.Refresh(req({ host: "box" }), s)).toBeUndefined();
  expect(U.Refresh(c, s)![1]!.startsWith(`phosphorus-user=${s.token}; Max-Age=259`)).toBe(true);
  // the setup admin off once an admin user exists
  expect((await U.Login({ user: "admin", pass: "bootpw" }, c)).status).toBe(403);
  // a wrong password, then the lockout after five from one address
  const bad = await U.Login({ user: "pmh", pass: "nope" }, c);
  expect(bad).toEqual({ status: 401, body: { error: "wrong user or password" } });
  for (let i = 0; i < 4; i++) await U.Login({ user: "pmh", pass: "nope" }, c);
  expect((await U.Login({ user: "pmh", pass: fx.pass }, c)).status).toBe(429);
  expect((await U.Login({ user: "pmh", pass: fx.pass }, req({}, "https://mesh.example/", "10.0.0.9"))).status).toBe(200);
});

test("users made here, their vault, mcp key and password change", async () => {
  const root = U.Of(sent((await U.Login({ user: "pmh", pass: fx.pass }, req({}, "https://mesh.example/", "10.0.0.8"))).cookie![0]!))!;
  expect(U.List(undefined).status).toBe(403);
  expect((await U.Create(root, { name: "Admin", pass: "pw12" })).status).toBe(400);
  expect((await U.Create(root, { name: "bob", pass: "pw1" })).status).toBe(400);
  const made = await U.Create(root, { name: " Bob ", pass: "pw12", admin: 0 });
  expect(made.body.users).toEqual([{ name: "bob", admin: false }, { name: "pmh", admin: true }]);
  expect((await U.Create(root, { name: "bob", pass: "pw12" })).status).toBe(409);
  // 127.0.0.1 is locked out by the test above
  const c = req({ host: "box:8090" }, "http://box:8090/api/x", "10.0.0.8");
  const bob = U.Of(sent((await U.Login({ user: "bob", pass: "pw12" }, c)).cookie![0]!))!;
  expect([bob.user, bob.admin]).toEqual(["bob", false]);
  expect(U.List(bob).status).toBe(403);
  const vault = { hosts: { razer: { user: "bob", pass: "p" }, "Bad Host": { user: "x" }, nouser: { pass: "y" } }, pages: { git: { url: "https://git.example", user: "g", pass: "s" } }, anthropic: "sk-ant-forged" };
  const sv = await U.SetVault(bob, { vault });
  expect(sv.body.vault).toEqual({ hosts: { razer: { user: "bob", pass: "p" } }, pages: { git: { url: "https://git.example", user: "g", pass: "s" } } });
  // an mcp key, a vault change resealed into it, a password change voiding it
  const k1 = await U.MCPKey(bob, undefined, c);
  expect([k1.status, k1.body.fresh, k1.body.hosts, k1.body.url]).toEqual([200, true, ["razer"], "https://mesh.example/api/mcp/" + k1.body.key]);
  expect(U.MCPLogin(k1.body.key, "razer")).toEqual(["bob", "p", true]);
  await U.SetVault(bob, { vault: { hosts: { mulab: { user: "b2", pass: "q" } } } });
  expect(U.MCPLogins(k1.body.key)).toEqual({ mulab: { user: "b2", pass: "q" } });
  expect(U.MCPPages(k1.body.key)).toEqual({});
  const k2 = await U.KeyOf(bob, c);
  expect(k2[1] && U.OpenGrant(k2[0])?.m === U.OpenGrant(k1.body.key)?.m).toBe(true);
  expect((await U.ChangePass(bob, { old: "wrong", pass: "pw34" }, c)).status).toBe(401);
  const ch = await U.ChangePass(bob, { old: "pw12", pass: "pw34" }, c);
  expect(ch.status).toBe(200);
  expect(U.Of(req({ cookie: "phosphorus-user=" + bob.token }))).toBeUndefined();
  const bob2 = U.Of(sent(ch.cookie![0]!))!;
  expect(await U.HostLogins(bob2)).toEqual(["mulab"]);
  expect(U.CheckMCPKey(k1.body.key)[1]).toBe("voided by a password change, make a new one");
  const k3 = await U.MCPKey(bob2, undefined, c);
  const k4 = await U.MCPKey(bob2, undefined, c);
  expect(U.CheckMCPKey(k3.body.key)[1]).toBe("revoked or replaced by a newer key");
  expect(U.OfMCPKey(k4.body.key)?.user).toBe("bob");
  expect(U.MCPRevoke(bob2).status).toBe(200);
  expect(U.CheckMCPKey(k4.body.key)[1]).toBe("revoked or replaced by a newer key");
  // prefs and the wallpaper
  const pr = U.SetPrefs(bob2, { prefs: { theme: "dark", icons: "", junk: "x" } });
  expect([pr.status, pr.body.prefs]).toEqual([200, { theme: "dark" }]);
  expect(U.SetWallpaper(bob2, { data: "data:image/bmp;base64,AAAA" }).status).toBe(400);
  const w = U.SetWallpaper(bob2, { data: "data:image/png;base64,iVBORw0KGgo=" });
  expect(w.body.wallpaper).toBeGreaterThan(0);
  const [wt, wb] = U.Wallpaper(bob2);
  expect([wt, hex(wb)]).toEqual(["image/png", "89504e470d0a1a0a"]);
  expect(U.SetWallpaper(bob2, { data: "" }).body).toEqual({ wallpaper: 0 });
  expect((await U.Me(bob2)).wallpaper).toBe(0);
  // admin flips and removal
  expect(U.SetAdmin(root, { name: "pmh", admin: false }).status).toBe(400);
  expect(U.SetAdmin(root, { name: "bob", admin: true }).body.users).toEqual([{ name: "bob", admin: true }, { name: "pmh", admin: true }]);
  expect(U.Remove(root, { name: "pmh" }).status).toBe(400);
  expect(U.Remove(root, { name: "bob" }).body.users).toEqual([{ name: "pmh", admin: true }]);
  expect(U.Exists("bob")).toBe(false);
});

// a logged in session over a vault holding hosts
function vaultSession(hosts: Record<string, any>): Session {
  const key = U.Derive("pw", "00").subarray(32);
  sysfs.write(U.vaultFile("ann"), U.Seal(key, marshal({ hosts, pages: {} })));
  return { user: "ann", admin: false, boot: false, key, token: "", e: 0 };
}

test("anthropic token", async () => {
  const s = vaultSession({ razer: { user: "ann", pass: "x" } });
  expect(await U.AnthropicToken(s)).toBe("");
  expect((await U.SetAnthropic(s, { token: "not a token\n" })).status).toBe(400);
  const o = await U.SetAnthropic(s, { token: " sk-ant-oat01-abc_DEF-123 " });
  expect([o.status, o.body.anthropic]).toEqual([200, true]);
  expect(await U.AnthropicToken(s)).toBe("sk-ant-oat01-abc_DEF-123");
  // sealed in the vault under the password's key, the logins kept
  const raw = marshal(sysfs.read(U.vaultFile("ann")));
  expect(raw !== "" && !raw.includes("sk-ant")).toBe(true);
  expect(await U.HostLogin(s, "razer")).toEqual(["ann", "x", true]);
  // another key (the mesh's, a wrong password) opens nothing
  expect(await U.AnthropicToken({ ...s, key: U.MeshKey() })).toBe("");
  // the page never sees it, and saving the page's vault keeps it
  expect((await U.Me(s)).vault.anthropic).toBeUndefined();
  const sv = await U.SetVault(s, { vault: { hosts: { "mulab-01": { user: "u", pass: "p" } }, anthropic: "sk-ant-forged" } });
  expect([sv.status, sv.body.vault.anthropic]).toEqual([200, undefined]);
  expect(await U.AnthropicToken(s)).toBe("sk-ant-oat01-abc_DEF-123");
  expect(await U.HostLogins(s)).toEqual(["mulab-01"]);
  expect((await U.SetAnthropic(s, { token: "" })).status).toBe(200);
  expect(await U.AnthropicToken(s)).toBe("");
  expect((await U.SetAnthropic({ user: "admin", admin: true, boot: true, token: "", e: 0 }, { token: "x" })).status).toBe(403);
  expect((await U.SetAnthropic({ ...s, key: undefined }, { token: "x" })).status).toBe(403);
});

test("cleanVault keeps the token", () => {
  const v = U.cleanVault({ hosts: {}, anthropic: "sk-ant-oat01-x", junk: 1 });
  expect([v.anthropic, v.junk]).toEqual(["sk-ant-oat01-x", undefined]);
  expect(U.cleanVault({ anthropic: "bad token\n" }).anthropic).toBeUndefined();
});

test("drop old tokens", () => {
  sysfs.write("home/ann/anthropic.json", { t: "x" });
  sysfs.write("home/ann/prefs.json", {});
  U.DropOldTokens();
  expect([sysfs.read("home/ann/anthropic.json"), sysfs.read("home/ann/prefs.json")]).toEqual([undefined, {}]);
});
