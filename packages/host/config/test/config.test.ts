import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-config-"));
process.env.PHOSPHORUS_REPO_DIR = dir;
process.env.SELF_HOST = "mike";
const store = await import("@phosphorus/store");
const util = await import("@phosphorus/util");
const { configRel } = util;
const { configValues, current, editKey, editModel, editShares, Keys, lineDiff, linkOk, migrate, wholeAtLeast } =
  await import("@phosphorus/config");

test("a record under the host's last name carried over once it's renamed", () => {
  mkdirSync(join(dir, "state", "run"), { recursive: true });
  writeFileSync(join(dir, "state", "run", "config-host"), "oldname\n");
  store.write(configRel("oldname"), {
    shares: [
      { dir: "/srv/media", perms: "r" },
      { dir: "/data", perms: "rwd" },
    ],
    model: { host: true, ctx: 4096 },
    stacks: { tz: "UTC" },
    apps: { code: { key: "RWabc" } },
  });
  migrate();
  expect(store.read(configRel("oldname"))).toBeUndefined();
  expect(current()).toEqual({
    shares: [
      { dir: "/srv/media", perms: "r" },
      { dir: "/data", perms: "rwd" },
    ],
    model: { host: true, gpu: false, url: "", ctx: 4096, slots: 0 },
    stacks: { tz: "UTC", puid: "", pgid: "" },
    apps: { code: { key: "RWabc" } },
  });
  expect(readFileSync(join(dir, "state", "run", "config-host"), "utf8")).toBe("mike\n");
});

test("editKey holds to Keys, files dir and priv in step", () => {
  expect(Keys.model).toEqual(["host", "gpu", "url", "ctx", "slots"]);
  expect(editKey("nope", "x", "1", false)).toEqual(["no section nope, only files, model, stacks", ""]);
  expect(editKey("files", "x", "1", false)).toEqual(["no key x in [files], only dir, priv", ""]);
  expect(editKey("files", "dir", "a\nb", false)).toEqual(["one line only", ""]);
  expect(editKey("files", "dir", "/srv", true)).toEqual([
    "",
    "+ share /srv r\n- share /srv/media r\n- share /data rwd",
  ]);
  expect(current().shares.length).toBe(2);
  expect(editKey("files", "dir", "/srv, /x", false)[0]).toBe("");
  expect(editKey("files", "priv", "rw, r", false)[1]).toBe(
    "+ share /srv rw\n+ share /x r\n- share /srv r\n- share /x rwd",
  );
  expect(editKey("model", "gpu", "true", false)[1]).toBe("+ model.gpu = true");
  expect(editKey("model", "gpu", "", false)[1]).toBe("- model.gpu = true");
  expect(editKey("stacks", "puid", "1001", false)[1]).toBe("+ stacks.puid = 1001");
  expect(editKey("files", "dir", "", false)[0]).toBe("");
  expect(current().shares).toEqual([]);
});

test("lineDiff lists gone and new lines, blanks left out", () => {
  expect(lineDiff("a\nb\n", "a\nb\n")).toBe("");
  expect(lineDiff("", "x\n\ny")).toBe("+ x\n+ y");
  expect(lineDiff("a\nb\nc", "a\nc\nd")).toBe("- b\n+ d");
  expect(lineDiff("a\nb", "b\na")).toBe("+ b\n- b");
});

test("model link and number checks", () => {
  expect(linkOk("https://h.co/x/model.gguf")).toBe(true);
  expect(linkOk("http://h.co/x.gguf")).toBe(false);
  expect(linkOk("https://h.co/page")).toBe(false);
  expect(linkOk("nope")).toBe(false);
  expect(wholeAtLeast(" 512 ", 512)).toBe(true);
  expect(wholeAtLeast("511", 512)).toBe(false);
  expect(wholeAtLeast("1.5", 1)).toBe(false);
  expect(wholeAtLeast("x", 1)).toBe(false);
});

test("settings › hosts: shares and model written whole and checked", async () => {
  expect(configValues().shares).toEqual([]);
  expect(editShares([{ dir: "", perms: "r" }], false)[0]).toBe("a share's folder is required");
  expect(editShares([{ dir: "/a,b", perms: "r" }], false)[0]).toBe("a folder can't contain a comma");
  expect(editShares([{ dir: "/srv", perms: "rr" }], false)[0]).toBe("perms is a mix of r, w and d");
  expect(
    editShares(
      [
        { dir: "/srv", perms: "r" },
        { dir: "/srv", perms: "rw" },
      ],
      false,
    )[0],
  ).toBe("/srv is shared twice");
  expect(
    editShares(
      [
        { dir: " /srv ", perms: "r" },
        { dir: "/media", perms: "rwd" },
      ],
      false,
    ),
  ).toEqual(["", "+ share /srv r\n+ share /media rwd"]);
  expect(configValues().shares).toEqual([
    { dir: "/srv", perms: "r" },
    { dir: "/media", perms: "rwd" },
  ]);
  expect(editModel({ host: "maybe" }, false)[0]).toBe("host is true or false");
  expect(editModel({ ctx: "100" }, false)[0]).toBe("ctx is a whole number of tokens, 512 or more");
  expect(editModel({ url: "http://x/a.gguf" }, false)[0]).toBe("url is a https link to a single .gguf");
  expect(editModel({ nope: "1" }, false)[0]).toBe("no key nope in [model], only host, gpu, url, ctx, slots");
  expect(editModel({ host: "true", slots: "2" }, false)[0]).toBe("");
  expect(configValues().model).toEqual({ host: "true", gpu: "false", url: "", ctx: "4096", slots: "2" });
  // nothing new: no write, no diff
  expect(editModel({ host: "true" }, false)).toEqual(["", ""]);
  // on disk for every process once written
  await util.flushWrites();
  expect(util.readConfig({ sys: store.Root, state: join(dir, "state"), self: "mike" }).model.slots).toBe(2);
});
