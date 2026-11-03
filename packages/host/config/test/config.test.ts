import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-cli-"));
process.env.PHOSPHORUS_CONFIG_DIR = dir;
const ini = join(dir, "phosphorus.ini");
const { editIni, IniKeys, iniText, lineDiff, setIni } = await import("@phosphorus/config");
const { appendSection, fieldsOf, joinDoc, keyOf, osErrText, rewriteSection, splitSections, linkOk, wholeAtLeast } =
  await import("@phosphorus/config");

const read = (f: string) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return undefined;
  }
};

test("sections split and join losslessly, comments and order kept", () => {
  const text = "# head\n\n[ web ]\nport = 8080\n; note\n\n[mc]\r\ntype = game\n";
  const d = splitSections(text);
  expect(d.head).toEqual(["# head", ""]);
  expect(d.secs.map((s) => s.name)).toEqual(["web", "mc"]);
  expect(joinDoc(d)).toBe(text.replaceAll("\r\n", "\n"));
  expect(fieldsOf(d.secs[0])).toEqual({ port: "8080" });
  expect(fieldsOf(undefined)).toEqual({});
  expect(keyOf("  scheme = https ")).toBe("scheme");
  expect(keyOf("# scheme = x")).toBe("");
  expect(keyOf("=x")).toBe("");
  expect(fieldsOf(splitSections('[a]\nx = "quoted"\n').secs[0])).toEqual({ x: "quoted" });
});

test("rewriteSection edits in place, drops, and adds after the last key", () => {
  const s = splitSections("[web]\n# c\nport = 1\nscheme = https\n\n").secs[0]!;
  const lines = rewriteSection(s, "web", { port: "2", scheme: undefined, mode: "subdomain", public: undefined }, [
    "port",
    "scheme",
    "mode",
    "public",
  ]);
  expect(lines).toEqual(["[web]", "# c", "port = 2", "mode = subdomain", "", ""]);
  // a blank value trimmed to "key =", nothing dangling
  expect(rewriteSection(s, "web", { port: "" }, ["port"])).toEqual([
    "[web]",
    "# c",
    "port =",
    "scheme = https",
    "",
    "",
  ]);
});

test("appendSection leaves one blank line before and one after", () => {
  const d = splitSections("[a]\nx = 1\n\n\n");
  appendSection(d, "b");
  expect(joinDoc(d)).toBe("[a]\nx = 1\n\n[b]\n");
  const e = splitSections("");
  appendSection(e, "b");
  expect(joinDoc(e)).toBe("[b]\n");
});

test("editIni holds to IniKeys and drops an emptied section", () => {
  expect(IniKeys.model).toEqual(["host", "gpu", "url", "ctx", "slots"]);
  expect(editIni("nope", "x", "1", false)).toEqual(["no section nope, only files, model", ""]);
  expect(editIni("files", "x", "1", false)).toEqual(["no key x in [files], only dir, priv", ""]);
  expect(editIni("files", "dir", "a\nb", false)).toEqual(["one line only", ""]);
  expect(editIni("files", "dir", "/srv", true)).toEqual(["", "+ [files]\n+ dir = /srv"]);
  expect(read(ini)).toBeUndefined();
  expect(setIni("files", "dir", " /srv ")).toBe("");
  expect(setIni("files", "priv", "rw")).toBe("");
  expect(setIni("model", "gpu", "true")).toBe("");
  expect(read(ini)).toBe("[files]\ndir = /srv\npriv = rw\n\n[model]\ngpu = true\n");
  expect(editIni("files", "priv", "", false)).toEqual(["", "- priv = rw"]);
  expect(editIni("model", "gpu", "", false)).toEqual(["", "- [model]\n- gpu = true"]);
  expect(read(ini)).toBe("[files]\ndir = /srv\n");
  expect(iniText()).toBe("[files]\ndir = /srv\n");
});

test.skipIf(process.platform === "win32")("a rewrite keeps the file's mode", () => {
  chmodSync(ini, 0o600);
  expect(setIni("model", "host", "true")).toBe("");
  expect(statSync(ini).mode & 0o777).toBe(0o600);
  expect(read(ini)).toBe("[files]\ndir = /srv\n\n[model]\nhost = true\n");
});

test("lineDiff lists gone and new lines, blanks left out", () => {
  expect(lineDiff("a\nb\n", "a\nb\n")).toBe("");
  expect(lineDiff("", "x\n\ny")).toBe("+ x\n+ y");
  expect(lineDiff("a\nb\nc", "a\nc\nd")).toBe("- b\n+ d");
  // a tie broken toward the new line first, as the Go diff did
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
  expect(osErrText(new Error("EACCES: permission denied, open '/x'"))).toBe("permission denied");
  expect(osErrText(new Error("other"))).toBe("other");
});

test("settings › hosts: shares and model written whole and checked", async () => {
  const { editModel, editShares, iniValues } = await import("@phosphorus/config");
  writeFileSync(ini, "");
  expect(iniValues().shares).toEqual([]);
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
  ).toEqual(["", "+ [files]\n+ dir = /srv, /media\n+ priv = r, rwd"]);
  expect(iniValues().shares).toEqual([
    { dir: "/srv", perms: "r" },
    { dir: "/media", perms: "rwd" },
  ]);
  // none shared: the section gone
  expect(editShares([], false)).toEqual(["", "- [files]\n- dir = /srv, /media\n- priv = r, rwd"]);
  expect(editModel({ host: "maybe" }, false)[0]).toBe("host is true or false");
  expect(editModel({ ctx: "100" }, false)[0]).toBe("ctx is a whole number of tokens, 512 or more");
  expect(editModel({ url: "http://x/a.gguf" }, false)[0]).toBe("url is a https link to a single .gguf");
  expect(editModel({ nope: "1" }, false)[0]).toBe("no key nope in [model], only host, gpu, url, ctx, slots");
  expect(editModel({ host: "true", slots: "2" }, false)[0]).toBe("");
  expect(iniValues().model).toEqual({ host: "true", gpu: "false", url: "", ctx: "", slots: "2" });
  // nothing new: no write, no diff
  expect(editModel({ host: "true" }, false)).toEqual(["", ""]);
});
