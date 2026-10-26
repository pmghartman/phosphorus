package sulfur

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// SULFUR_VSIX_DIR=dir converts every .vsix in dir and prints its report: real
// packages (from open-vsx.org) checked by hand, none checked in
func TestConvertVSIXDir(t *testing.T) {
	dir := os.Getenv("SULFUR_VSIX_DIR")
	if dir == "" {
		t.Skip("SULFUR_VSIX_DIR unset")
	}
	names, _ := filepath.Glob(filepath.Join(dir, "*.vsix"))
	for _, n := range names {
		data, err := os.ReadFile(n)
		if err != nil {
			t.Fatal(err)
		}
		conv, err := ConvertVSIX(data, VSXSource{}, VSXOptions{Commands: map[string]bool{"editor.action.copyLinesDownAction": true}})
		if err != nil {
			t.Errorf("%s: %v", filepath.Base(n), err)
			continue
		}
		size := 0
		for _, f := range conv.Files {
			size += len(f)
		}
		t.Logf("=== %s → %s (%d files, %dKB)", filepath.Base(n), conv.ID, len(conv.Files), size>>10)
		for _, r := range conv.Report {
			t.Logf("  %-15s %-9s %s — %s", r.Kind, r.Status, r.Name, r.Detail)
		}
		if out := os.Getenv("SULFUR_VSIX_OUT"); out != "" {
			for rel, text := range conv.Files {
				p := filepath.Join(out, conv.ID, filepath.FromSlash(rel))
				os.MkdirAll(filepath.Dir(p), 0o755)
				os.WriteFile(p, []byte(text), 0o644)
			}
		}
	}
}

// --- fixtures: small packages made in the test -------------------------------------------

func vsix(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	for name, text := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(text))
	}
	zw.Close()
	return b.Bytes()
}

func convert(t *testing.T, files map[string]string, opt VSXOptions) (*VSXConversion, map[string]any) {
	t.Helper()
	conv, err := ConvertVSIX(vsix(t, files), VSXSource{Namespace: "pub", Name: "ext", Version: "1.0.0"}, opt)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(conv.Files["package.json"]), &m); err != nil {
		t.Fatal(err)
	}
	return conv, m
}

func reportOf(conv *VSXConversion, kind string) []VSXReportItem {
	var out []VSXReportItem
	for _, r := range conv.Report {
		if r.Kind == kind {
			out = append(out, r)
		}
	}
	return out
}

func readJSON(t *testing.T, conv *VSXConversion, rel string) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(conv.Files[rel]), &v); err != nil {
		t.Fatalf("%s: %v", rel, err)
	}
	return v
}

func TestStripJSONC(t *testing.T) {
	in := `{
	// a comment, "with a quote
	"a": "http://x//y", /* block */ "b": [1, 2,],
	"c": {"d": "\"//\"",},
}`
	var v map[string]any
	if err := json.Unmarshal(stripJSONC([]byte(in)), &v); err != nil {
		t.Fatal(err, string(stripJSONC([]byte(in))))
	}
	if v["a"] != "http://x//y" || len(v["b"].([]any)) != 2 || v["c"].(map[string]any)["d"] != `"//"` {
		t.Fatal(v)
	}
}

func TestPlist(t *testing.T) {
	v, err := parsePlist([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>scopeName</key><string>source.demo</string>
  <key>patterns</key><array><dict><key>match</key><string>\b(if|else)\b &amp; more</string><key>name</key><string>keyword.control.demo</string></dict></array>
  <key>hidden</key><true/>
  <key>n</key><integer>3</integer>
</dict></plist>`))
	if err != nil {
		t.Fatal(err)
	}
	m := v.(map[string]any)
	p := m["patterns"].([]any)[0].(map[string]any)
	if m["scopeName"] != "source.demo" || p["match"] != `\b(if|else)\b & more` || m["hidden"] != true || m["n"] != 3.0 {
		t.Fatal(m)
	}
}

func TestColorTheme(t *testing.T) {
	conv, m := convert(t, map[string]string{
		"extension/package.json": `{"publisher": "pub", "name": "ext", "displayName": "%name%", "contributes": {"themes": [
			{"label": "Night", "uiTheme": "vs-dark", "path": "./themes/night.json"},
			{"label": "Day", "uiTheme": "vs", "path": "./themes/day.tmTheme"},
			{"label": "Gone", "uiTheme": "vs", "path": "./themes/missing.json"}]}}`,
		"extension/package.nls.json": `{"name": "Night and Day"}`,
		"extension/themes/base.json": `{"colors": {"editor.background": "#101010", "editor.foreground": "#eeeeee"},
			"tokenColors": [{"scope": "comment", "settings": {"foreground": "#777777", "fontStyle": "italic"}}]}`,
		"extension/themes/night.json": `{
			// it includes its base, then overrides
			"include": "./base.json",
			"colors": {"editor.background": "#000000", "sideBar.background": "#111111aa", "button.background": "url(evil)",},
			"tokenColors": [
				{"scope": ["keyword", "storage.type"], "settings": {"foreground": "#ff0000"}},
				{"scope": "keyword.control", "settings": {"foreground": "#ff00ff"}},
				{"scope": "string, string.quoted", "settings": {"foreground": "#00ff00"}},
				{"scope": "comment", "settings": {"fontStyle": ""}},
				{"scope": "entity.name.function", "settings": {"foreground": "#0000ff"}},
			]}`,
		"extension/themes/day.tmTheme": `<plist><dict><key>settings</key><array>
			<dict><key>settings</key><dict><key>background</key><string>#ffffff</string><key>foreground</key><string>#202020</string></dict></dict>
			<dict><key>scope</key><string>keyword</string><key>settings</key><dict><key>foreground</key><string>#aa0000</string></dict></dict>
		</array></dict></plist>`,
	}, VSXOptions{})
	if m["displayName"] != "Night and Day" || m["main"] != nil || m["sulfur"].(map[string]any)["declarative"] != true {
		t.Fatal(m)
	}
	themes := m["contributes"].(map[string]any)["themes"].([]any)
	if len(themes) != 2 {
		t.Fatal(themes)
	}
	night := readJSON(t, conv, themes[0].(map[string]any)["path"].(string))
	vars := night["vars"].(map[string]any)
	for k, want := range map[string]any{
		"--ide-bg": "#000000", "--ide-side": "#111111aa", "--ide-fg": "#eeeeee",
		"--hl-kw": "#ff00ff", "--hl-str": "#00ff00", "--hl-title": "#0000ff", "--hl-cmt": "#777777", "--hl-cmt-style": "normal",
		"--ide-button": nil,
	} {
		if vars[k] != want {
			t.Errorf("%s = %v, want %v", k, vars[k], want)
		}
	}
	if night["type"] != "dark" {
		t.Error(night["type"])
	}
	day := readJSON(t, conv, themes[1].(map[string]any)["path"].(string))
	if day["type"] != "light" || day["vars"].(map[string]any)["--ide-bg"] != "#ffffff" || day["vars"].(map[string]any)["--hl-kw"] != "#aa0000" {
		t.Error(day)
	}
	r := reportOf(conv, "theme")
	if len(r) != 3 || r[2].Status != vsxSkipped || r[2].Name != "Gone" {
		t.Error(r)
	}
}

func TestIconTheme(t *testing.T) {
	conv, m := convert(t, map[string]string{
		"extension/package.json": `{"publisher": "pub", "name": "ext", "contributes": {"iconThemes": [{"id": "my-icons", "label": "My Icons", "path": "./icons/theme.json"}]}}`,
		"extension/icons/theme.json": `{
			"iconDefinitions": {
				"_file": {"iconPath": "./svg/file.svg"},
				"_folder": {"iconPath": "./svg/folder.svg"},
				"_ts": {"fontCharacter": "\\E001", "fontColor": "#3178c6"},
				"_unused": {"iconPath": "./svg/unused.svg"},
				"_lost": {"iconPath": "./svg/lost.svg"}
			},
			"fonts": [{"id": "glyphs", "src": [{"path": "./glyphs.woff", "format": "woff"}], "size": "150%"}],
			"file": "_file", "folder": "_folder",
			"fileExtensions": {"TS": "_ts", "md": "_lost"},
			"languageIds": {"lua": "_ts"},
			"light": {"fileNames": {"Makefile": "_folder"}}
		}`,
		"extension/icons/svg/file.svg":   `<svg xmlns="http://www.w3.org/2000/svg"/>`,
		"extension/icons/svg/folder.svg": `<svg xmlns="http://www.w3.org/2000/svg"/>`,
		"extension/icons/svg/unused.svg": `<svg/>`,
		"extension/icons/glyphs.woff":    "wOFF",
	}, VSXOptions{})
	list := m["contributes"].(map[string]any)["iconThemes"].([]any)
	th := readJSON(t, conv, list[0].(map[string]any)["path"].(string))
	defs := th["defs"].(map[string]any)
	if _, ok := defs["_unused"]; ok {
		t.Error("an unused icon inlined")
	}
	if !strings.HasPrefix(defs["_file"].(map[string]any)["src"].(string), "data:image/svg+xml;base64,") {
		t.Error(defs["_file"])
	}
	ts := defs["_ts"].(map[string]any)
	if ts["char"] != "" || ts["color"] != "#3178c6" || ts["font"] != "glyphs" {
		t.Error(ts)
	}
	if th["fonts"].(map[string]any)["glyphs"].(map[string]any)["size"] != "150%" {
		t.Error(th["fonts"])
	}
	if th["fileExtensions"].(map[string]any)["ts"] != "_ts" || th["languageExtensions"].(map[string]any)["lua"] != "_ts" {
		t.Error(th)
	}
	if th["light"].(map[string]any)["fileNames"].(map[string]any)["makefile"] != "_folder" {
		t.Error(th["light"])
	}
	if r := reportOf(conv, "iconTheme"); len(r) != 1 || r[0].Status != vsxPartial {
		t.Error(r)
	}
}

func TestLanguagesGrammarsSnippets(t *testing.T) {
	conv, m := convert(t, map[string]string{
		"extension/package.json": `{"publisher": "pub", "name": "ext", "contributes": {
			"languages": [{"id": "demo", "aliases": ["Demo", "demo"], "extensions": [".demo", ".DM"], "filenames": ["Demofile"], "configuration": "./demo.language-configuration.json"},
				{"id": "demo", "filenamePatterns": ["*.demo.txt"]}],
			"grammars": [{"language": "demo", "scopeName": "source.demo", "path": "./syntaxes/demo.tmLanguage"},
				{"language": "go", "scopeName": "source.go", "path": "./syntaxes/go.json"},
				{"scopeName": "demo.injection", "path": "./syntaxes/inject.json", "injectTo": ["source.js"]}],
			"snippets": [{"language": "demo", "path": "./snippets/demo.code-snippets"}, {"language": "javascript", "path": "./snippets/js.json"}]}}`,
		"extension/demo.language-configuration.json": `{"comments": {"lineComment": "--", "blockComment": ["{-", "-}"]}, "brackets": [["{", "}"], ["(", ")"]],
			"autoClosingPairs": [{"open": "\"", "close": "\""}], "onEnterRules": []}`,
		"extension/syntaxes/demo.tmLanguage": `<plist><dict><key>scopeName</key><string>source.demo</string><key>patterns</key><array>
			<dict><key>match</key><string>\b(let|in)\b</string><key>name</key><string>keyword.demo</string></dict></array></dict></plist>`,
		"extension/syntaxes/go.json":     `{"scopeName": "source.go", "patterns": [{"match": "func", "name": "keyword"}]}`,
		"extension/syntaxes/inject.json": `{"scopeName": "demo.injection", "patterns": []}`,
		"extension/snippets/demo.code-snippets": `{
			// comments allowed
			"Let": {"prefix": ["let", "lt"], "body": ["let ${1:x} = $0", "in"], "description": "a let"},
			"File": {"prefix": "file", "body": "-- ${TM_FILENAME}"},
			"NoPrefix": {"body": "x"},
		}`,
		"extension/snippets/js.json": `{"Log": {"prefix": "log", "body": "console.log($1)", "scope": "javascript,typescript"}}`,
	}, VSXOptions{})
	c := m["contributes"].(map[string]any)
	langs := c["languages"].([]any)
	var demo map[string]any
	for _, l := range langs {
		if l.(map[string]any)["id"] == "demo" {
			demo = l.(map[string]any)
		}
	}
	if demo == nil || strings.Join(toStrings(demo["extensions"]), " ") != "demo dm" || strings.Join(toStrings(demo["filenames"]), " ") != "demofile" {
		t.Fatal(langs)
	}
	if cm := demo["comments"].(map[string]any); cm["lineComment"] != "--" || len(cm["blockComment"].([]any)) != 2 || len(demo["brackets"].([]any)) != 2 || len(demo["autoClosingPairs"].([]any)) != 1 {
		t.Error(demo)
	}
	grammars := c["grammars"].([]any)
	if len(grammars) != 2 {
		t.Fatal(grammars)
	}
	g := readJSON(t, conv, grammars[0].(map[string]any)["path"].(string))
	if g["scopeName"] != "source.demo" || g["patterns"].([]any)[0].(map[string]any)["match"] != `\b(let|in)\b` {
		t.Error(g)
	}
	gr := reportOf(conv, "grammar")
	if len(gr) != 3 || gr[0].Status != vsxConverted || gr[1].Status != vsxPartial || gr[2].Status != vsxSkipped {
		t.Error(gr)
	}
	lr := reportOf(conv, "language")
	if len(lr) != 2 || lr[0].Status != vsxPartial || !strings.Contains(lr[0].Detail, "onEnterRules") || !strings.Contains(lr[1].Detail, "patterns") {
		t.Error(lr)
	}
	snips := c["snippets"].([]any)
	s0 := snips[0].(map[string]any)
	items := []map[string]any{}
	json.Unmarshal([]byte(conv.Files[s0["path"].(string)]), &items)
	if len(items) != 2 || items[1]["body"] != "let ${1:x} = $0\nin" || strings.Join(toStrings(items[1]["prefix"]), ",") != "let,lt" || strings.Join(toStrings(s0["extensions"]), " ") != "demo dm" {
		t.Error(items, s0)
	}
	s1 := snips[1].(map[string]any)
	if exts := strings.Join(toStrings(s1["extensions"]), " "); !strings.Contains(exts, "js") || !strings.Contains(exts, "ts") {
		t.Error(s1)
	}
	sr := reportOf(conv, "snippets")
	if sr[0].Status != vsxPartial || !strings.Contains(sr[0].Detail, "1 use variables") || sr[1].Status != vsxConverted {
		t.Error(sr)
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range asList(v) {
		out = append(out, str(x))
	}
	return out
}

func TestKeybindingsAndUnsupported(t *testing.T) {
	conv, m := convert(t, map[string]string{
		"extension/package.json": `{"publisher": "pub", "name": "ext", "main": "./out/extension.js", "contributes": {
			"commands": [{"command": "ext.go", "title": "Go"}],
			"keybindings": [
				{"command": "editor.action.copyLinesDownAction", "key": "Ctrl+Shift+D", "when": "editorTextFocus"},
				{"command": "-workbench.action.openRecent", "key": "ctrl+r"},
				{"command": "ext.go", "key": "ctrl+g"},
				{"command": "vim.thing", "key": "ctrl+v"}],
			"debuggers": [{"type": "x"}], "views": {}, "configuration": {"properties": {"ext.a": {"default": 1}}},
			"frobnicate": []}}`,
		"extension/out/extension.js": "exports.activate = () => {}",
	}, VSXOptions{Commands: map[string]bool{"editor.action.copyLinesDownAction": true, "workbench.action.openRecent": true}})
	kb := m["contributes"].(map[string]any)["keybindings"].([]any)
	if len(kb) != 2 || kb[0].(map[string]any)["key"] != "ctrl+shift+d" || kb[1].(map[string]any)["command"] != "-workbench.action.openRecent" {
		t.Fatal(kb)
	}
	r := reportOf(conv, "keybindings")[0]
	if r.Status != vsxPartial || !strings.Contains(r.Detail, "1 `when`") || !strings.Contains(r.Detail, "own commands") || !strings.Contains(r.Detail, "vim.thing") {
		t.Error(r)
	}
	for kind, status := range map[string]string{"commands": vsxSkipped, "code": vsxSkipped, "debuggers": vsxSkipped, "views": vsxSkipped, "settings": vsxSkipped, "frobnicate": vsxSkipped} {
		if r := reportOf(conv, kind); len(r) != 1 || r[0].Status != status {
			t.Errorf("%s: %v", kind, r)
		}
	}
	if _, ok := m["contributes"].(map[string]any)["languageServers"]; ok {
		t.Error("a server found in a package without one")
	}
}

func TestLanguageServer(t *testing.T) {
	conv, m := convert(t, map[string]string{
		"extension/package.json": `{"publisher": "pub", "name": "ext", "displayName": "Demo LS", "main": "./dist/extension",
			"activationEvents": ["onLanguage:demo"], "dependencies": {"vscode-languageclient": "9"},
			"contributes": {"languages": [{"id": "demo", "extensions": [".demo"]}],
			"configuration": {"properties": {"demo.trace.server": {"default": "off"}, "demo.format.enable": {"default": true}}}}}`,
		"extension/dist/extension.js":                                   `const m = ctx.asAbsolutePath("./dist/languageserver.js"),P=e.asAbsolutePath("./dist/l10n"); new LanguageClient("demo", {documentSelector: [{language: "yaml"}],initializationOptions:{l10nPath:P,icons:ctx.asAbsolutePath("media/icons"),other:x.y}})`,
		"extension/dist/languageserver.js":                              "server",
		"extension/dist/languageserver-web.js":                          "web server",
		"extension/node_modules/vscode-languageserver/lib/node/main.js": "lib",
	}, VSXOptions{})
	servers := m["contributes"].(map[string]any)["languageServers"].([]any)
	s := servers[0].(map[string]any)
	if s["entry"] != "extension/dist/languageserver.js" || s["runtime"] != "node" || s["transport"] != "ipc" || len(toStrings(s["args"])) != 0 {
		t.Fatal(s)
	}
	if strings.Join(toStrings(s["languages"]), " ") != "demo yaml" || !strings.Contains(strings.Join(toStrings(s["extensions"]), " "), "yml") || s["languageIds"].(map[string]any)["demo"] != "demo" {
		t.Error(s)
	}
	if opts := s["initializationOptions"].(map[string]any); len(opts) != 2 || opts["l10nPath"] != "${extensionPath}/dist/l10n" || opts["icons"] != "${extensionPath}/media/icons" {
		t.Error("initialization options", opts)
	}
	settings := s["settings"].(map[string]any)["demo"].(map[string]any)
	if settings["format"].(map[string]any)["enable"] != true || settings["trace"].(map[string]any)["server"] != "off" {
		t.Error(settings)
	}
	if r := reportOf(conv, "languageServer"); len(r) != 1 || r[0].Status != vsxPartial {
		t.Error(r)
	}
	if r := reportOf(conv, "settings"); r[0].Status != vsxPartial {
		t.Error(r)
	}

	// a native server; and a client whose server isn't in its package
	_, m = convert(t, map[string]string{
		"extension/package.json":                       `{"publisher": "pub", "name": "lua", "main": "./client/out/extension.js", "activationEvents": ["onLanguage:lua"]}`,
		"extension/client/out/extension.js":            `require("vscode-languageclient/node"); new LanguageClient("lua")`,
		"extension/server/bin/lua-language-server.exe": "MZ",
		"extension/server/bin/msvcp140.dll":            "MZ",
	}, VSXOptions{})
	s = m["contributes"].(map[string]any)["languageServers"].([]any)[0].(map[string]any)
	if s["entry"] != "extension/server/bin/lua-language-server.exe" || s["runtime"] != "binary" || len(toStrings(s["args"])) != 0 {
		t.Error(s)
	}
	conv, m = convert(t, map[string]string{
		"extension/package.json":     `{"publisher": "pub", "name": "clangd", "main": "./out/extension.js", "devDependencies": {"vscode-languageclient": "9"}, "activationEvents": ["onLanguage:cpp"]}`,
		"extension/out/extension.js": `download("https://github.com/clangd/clangd/releases")`,
	}, VSXOptions{})
	if _, ok := m["contributes"].(map[string]any)["languageServers"]; ok {
		t.Error("a server made of nothing")
	}
	if r := reportOf(conv, "languageServer"); len(r) != 1 || r[0].Status != vsxSkipped || !strings.Contains(r[0].Detail, "doesn't carry") {
		t.Error(r)
	}
}

func TestPlan(t *testing.T) {
	var m map[string]any
	json.Unmarshal([]byte(`{"main": "x.js", "dependencies": {"vscode-languageclient": "1"}, "contributes": {"themes": [{}, {}], "grammars": [{}], "debuggers": [], "commands": []}, "extensionPack": ["a.b"]}`), &m)
	got := map[string]string{}
	for _, r := range VSXPlan(m) {
		got[r.Kind] = r.Status + " " + r.Name
	}
	for k, want := range map[string]string{"theme": "converted 2 color themes", "grammar": "converted 1 grammar", "languageServer": "partial language server", "code": "skipped extension code", "other": "skipped commands, debuggers", "extensionPack": "skipped 1 bundled extension"} {
		if got[k] != want {
			t.Errorf("%s: %q, want %q", k, got[k], want)
		}
	}
}

func TestBadPackages(t *testing.T) {
	if _, err := ConvertVSIX([]byte("not a zip"), VSXSource{}, VSXOptions{}); err == nil {
		t.Error("a non-zip taken")
	}
	if _, err := ConvertVSIX(vsix(t, map[string]string{"extension/readme.md": "x"}), VSXSource{}, VSXOptions{}); err == nil {
		t.Error("a package without package.json taken")
	}
	// paths out of the package refused
	conv, _ := convert(t, map[string]string{
		"extension/package.json": `{"publisher": "p", "name": "n", "contributes": {"themes": [{"label": "Out", "path": "../../etc/passwd"}], "snippets": [{"language": "x", "path": "/abs.json"}]}}`,
	}, VSXOptions{})
	for _, r := range conv.Report {
		if r.Status != vsxSkipped {
			t.Error(r)
		}
	}
	if VSXID("Some Pub", "My..Ext!") != "some-pub.my..ext" {
		t.Error(VSXID("Some Pub", "My..Ext!"))
	}
}
