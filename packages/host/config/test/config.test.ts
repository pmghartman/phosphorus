import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-cli-"));
process.env.PHOSPHORUS_CONFIG_DIR = dir;
// proxy's domain is fixed on its first import: the one its own test expects
process.env.BASE_DOMAIN ??= "mulab.dev";
const svc = join(dir, "services.export"),
  ini = join(dir, "phosphorus.ini");
const { configText, editIni, editService, IniKeys, lineDiff, setIni, setService } = await import("@phosphorus/config");
const {
  appendSection,
  dropSection,
  fieldsOf,
  joinDoc,
  keyOf,
  osErrText,
  rewriteSection,
  splitSections,
  linkOk,
  wholeAtLeast,
} = await import("@phosphorus/config");

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

test("dropSection takes its own comment and leaves the next one's", () => {
  const drop = (text: string, ...names: string[]) => {
    const d = splitSections(text);
    for (const n of names) dropSection(d, n);
    return joinDoc(d);
  };
  const three = "[a]\nport = 1\n\n# found by phosphorus: B\n[b]\nport = 2\n\n# found by phosphorus: C\n[c]\nport = 3\n";
  expect(drop(three, "b")).toBe("[a]\nport = 1\n\n# found by phosphorus: C\n[c]\nport = 3\n");
  // the last: the file still ends in a newline
  expect(drop(three, "c")).toBe("[a]\nport = 1\n\n# found by phosphorus: B\n[b]\nport = 2\n");
  // laptop-hfpo6itm's: both found pages taken out, no comment left behind
  const laptop = "\n# c1\n[a]\nport = 1\n\n# c2\n[b]\nport = 2\n";
  expect(drop(laptop, "a")).toBe("# c2\n[b]\nport = 2\n");
  expect(drop(laptop, "a", "b")).toBe("");
  expect(drop(laptop, "b", "a")).toBe("");
  expect(drop(laptop, "nope")).toBe(laptop);
});

test("editService creates, edits, rejects and removes", () => {
  // services' own checks, nothing of config's
  expect(editService("Web", { port: "1" }, false, false)).toEqual(["[Web] 'Web' is not a valid name", ""]);
  expect(editService("web", { nope: "1" }, false, false)).toEqual([
    "no field nope, only port, scheme, max_body, public, type, start, stop",
    "",
  ]);
  expect(editService("web", { mode: "path" }, false, false)[0]).toBe(
    "no field mode, only port, scheme, max_body, public, type, start, stop",
  );
  expect(editService("web", {}, false, false)).toEqual(["[web] has no port", ""]);
  expect(editService("web", { port: "1", start: "x" }, false, false)).toEqual([
    "[web] start and stop are for games only",
    "",
  ]);
  expect(editService("mc", { port: "1", type: "game", start: "x" }, false, false)).toEqual([
    "[mc] start and stop go together",
    "",
  ]);
  expect(editService("web", {}, true, false)).toEqual(["no service web", ""]);
  // dry: the diff alone, nothing on disk
  expect(editService("web", { port: " 8080 " }, false, true)).toEqual(["", "+ [web]\n+ port = 8080"]);
  expect(read(svc)).toBeUndefined();
  expect(editService("web", { port: "8080" }, false, false)).toEqual(["", "+ [web]\n+ port = 8080"]);
  expect(read(svc)).toBe("[web]\nport = 8080\n");
  // a second one after a blank line, the first untouched
  expect(setService("mc", { port: "25565", type: "game", start: "a", stop: "b" }, false)).toBe("");
  expect(read(svc)).toBe("[web]\nport = 8080\n\n[mc]\nport = 25565\ntype = game\nstart = a\nstop = b\n");
  writeFileSync(
    svc,
    "# mine\n[web]\n# the port\nport = 8080\nscheme = https\n\n[mc]\nport = 25565\ntype = game\nstart = a\nstop = b\n",
  );
  expect(editService("web", { scheme: "", max_body: "50MB" }, false, false)).toEqual([
    "",
    "+ max_body = 50MB\n- scheme = https",
  ]);
  expect(read(svc)).toBe(
    "# mine\n[web]\n# the port\nport = 8080\nmax_body = 50MB\n\n[mc]\nport = 25565\ntype = game\nstart = a\nstop = b\n",
  );
  // a bad edit never reaches disk
  const before = read(svc);
  const [why] = editService("web", { port: "nope" }, false, false);
  expect(why).not.toBe("");
  expect(read(svc)).toBe(before!);
  // its comment above it goes with it
  expect(editService("web", {}, true, true)).toEqual([
    "",
    "- # mine\n- [web]\n- # the port\n- port = 8080\n- max_body = 50MB",
  ]);
  expect(setService("web", {}, true)).toBe("");
  expect(read(svc)).toBe("[mc]\nport = 25565\ntype = game\nstart = a\nstop = b\n");
});

test("editService drops old keys and renames", () => {
  writeFileSync(svc, '[web]\nport = 8080\nmode = path\nextras = {"max_body": "50MB", "flush_interval": -1}\n');
  // any edit takes the old keys out, extras' max_body kept, the diff showing it
  expect(editService("web", { public: "true" }, false, false)).toEqual([
    "",
    '+ max_body = 50MB\n+ public = true\n- mode = path\n- extras = {"max_body": "50MB", "flush_interval": -1}',
  ]);
  expect(read(svc)).toBe("[web]\nport = 8080\nmax_body = 50MB\npublic = true\n");
  expect(editService("site", {}, false, false, "nope")).toEqual(["no service nope", ""]);
  expect(setService("mc", { port: "25565", type: "game", start: "a", stop: "b" }, false)).toBe("");
  expect(editService("mc", {}, false, false, "web")).toEqual(["there's already a service mc", ""]);
  expect(editService("site", { port: "8081" }, false, false, "web")[0]).toBe("");
  expect(read(svc)).toBe(
    "[site]\nport = 8081\nmax_body = 50MB\npublic = true\n\n[mc]\nport = 25565\ntype = game\nstart = a\nstop = b\n",
  );
});

test("editIni holds to IniKeys and drops an emptied section", () => {
  expect(IniKeys.model).toEqual(["host", "gpu", "url", "ctx", "slots"]);
  expect(editIni("nope", "x", "1", false)).toEqual(["no section nope, only files, git, model", ""]);
  expect(editIni("files", "x", "1", false)).toEqual(["no key x in [files], only dir, priv", ""]);
  expect(editIni("files", "dir", "a\nb", false)).toEqual(["one line only", ""]);
  expect(editIni("files", "dir", "/srv", true)).toEqual(["", "+ [files]\n+ dir = /srv"]);
  expect(read(ini)).toBeUndefined();
  expect(setIni("files", "dir", " /srv ")).toBe("");
  expect(setIni("files", "priv", "rw")).toBe("");
  expect(setIni("git", "host", "true")).toBe("");
  expect(read(ini)).toBe("[files]\ndir = /srv\npriv = rw\n\n[git]\nhost = true\n");
  expect(editIni("files", "priv", "", false)).toEqual(["", "- priv = rw"]);
  expect(editIni("git", "host", "", false)).toEqual(["", "- [git]\n- host = true"]);
  expect(read(ini)).toBe("[files]\ndir = /srv\n");
  expect(configText()).toEqual(["[files]\ndir = /srv\n", read(svc)!]);
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
