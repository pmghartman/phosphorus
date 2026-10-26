package sulfur

// A VS Code extension's web build (package.json's "browser", what vscode.dev runs): its
// code runs in Sulfur's sandboxed extension frame under a `vscode` API shim
// (web/src/sulfur/vscode-shim.js), its commands in the palette, its webview panels and
// custom editors in Sulfur's webview tabs. The package's files go along under vscode/ in
// the converted extension, binary ones (wasm, images, fonts) as they are; a Node-only
// extension's code can't come, there being no Node extension host in Sulfur.

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	// what a converted web build may carry, its code and assets together
	vsxWebMax = 48 << 20
	vsxWebDir = "vscode"
)

// the package's files a web build never needs
var vsxWebSkip = regexp.MustCompile(`(?i)(\.map$|\.ts$|\.tsx$|(^|/)(readme|changelog)[^/]*$|(^|/)\.[^/]+$|(^|/)(test|tests|__tests__|\.github|\.vscode)/|node_modules/\.bin/|node_modules/[^/]+/(src|test|tests|docs?)/)`)

// webBuild the package's web entry, "" when it has none
func (c *converter) webBuild() string {
	b := cleanRel("", str(c.m["browser"]))
	if b == "" {
		return ""
	}
	if path.Ext(b) == "" {
		b += ".js"
	}
	if c.pkg.files[b] == nil {
		return ""
	}
	return b
}

// wantsWeb whether a web build is worth running: for the UI only its code draws (webviews,
// custom editors), or the commands of an extension that isn't a theme or a language server
// (whose web code would only set VS Code's settings, or start the server Sulfur runs itself)
func (c *converter) wantsWeb(contributes map[string]any, browser string, server map[string]any) bool {
	code, err := c.pkg.read(browser)
	if err != nil {
		return false
	}
	ui := len(asList(contributes["customEditors"])) > 0 || len(asMap(contributes["views"])) > 0 || bytes.Contains(code, []byte("createWebviewPanel")) ||
		bytes.Contains(code, []byte("registerWebviewViewProvider")) || bytes.Contains(code, []byte("registerCustomEditorProvider"))
	declared := len(asList(contributes["themes"]))+len(asList(contributes["iconThemes"])) > 0
	return ui || (!declared && server == nil)
}

// webExtension the web build and the files it may load, under vscode/; its commands and
// custom editors declared for the workbench
func (c *converter) webExtension(contributes map[string]any, browser string) {
	code, err := c.pkg.read(browser)
	if err != nil {
		c.add("code", vsxSkipped, "web build", err.Error())
		return
	}
	// a package of node_modules goes along only when the code names it (codicons, a wasm build)
	named := map[string]bool{}
	for _, m := range stringLiteralRe.FindAllSubmatch(code, -1) {
		for _, part := range strings.Split(string(m[1]), "/") {
			named[part] = true
		}
	}
	nodeMain := cleanRel("", str(c.m["main"]))
	if nodeMain != "" && path.Ext(nodeMain) == "" {
		nodeMain += ".js"
	}
	var rels []string
	for rel := range c.pkg.files {
		rels = append(rels, rel)
	}
	// The executable must fit before optional assets; alphabetical order can put
	// a large media directory ahead of the entry and otherwise omit the main module.
	sort.Slice(rels, func(i, j int) bool {
		if rels[i] == browser || rels[j] == browser {
			return rels[i] == browser
		}
		return rels[i] < rels[j]
	})
	size, skipped, binary := 0, 0, 0
	for _, rel := range rels {
		f := c.pkg.files[rel]
		if rel != browser && (vsxWebSkip.MatchString(rel) || rel == nodeMain || rel == "package.json" || strings.HasPrefix(rel, "package.nls.") && rel != "package.nls.json") {
			continue
		}
		if i := strings.Index(rel, "node_modules/"); i >= 0 {
			pkgName := strings.SplitN(rel[i+len("node_modules/"):], "/", 2)[0]
			if !named[pkgName] {
				continue
			}
		}
		if f.UncompressedSize64 > uint64(vsxWebMax-size) {
			skipped++
			continue
		}
		b, err := c.pkg.read(rel)
		if err != nil {
			skipped++
			continue
		}
		size += len(b)
		out := vsxWebDir + "/" + rel
		if utf8.Valid(b) && !bytes.ContainsRune(b, 0) {
			c.files[out] = string(b)
		} else {
			c.binary[out] = base64.StdEncoding.EncodeToString(b)
			binary++
		}
	}
	// its own package.json, for the shim's extension.packageJSON and its settings' defaults
	if b, err := c.pkg.read("package.json"); err == nil {
		c.files[vsxWebDir+"/package.json"] = string(b)
	}
	c.web = vsxWebDir + "/" + browser

	// its commands in the palette, their keys bound: its code runs now
	var cmds []any
	for _, x := range asList(contributes["commands"]) {
		cm := asMap(x)
		if str(cm["command"]) == "" {
			continue
		}
		cmd := map[string]any{"command": cm["command"], "title": c.pkg.localize(cm["title"])}
		if cat := c.pkg.localize(cm["category"]); cat != "" {
			cmd["category"] = cat
		}
		cmds = append(cmds, cmd)
	}
	if len(cmds) > 0 {
		c.contrib["commands"] = cmds
		c.add("commands", vsxConverted, plural(len(cmds), "command"), "in the command palette, run by its code")
	}
	var editors []any
	for _, x := range asList(contributes["customEditors"]) {
		ce := asMap(x)
		var patterns []string
		for _, s := range asList(ce["selector"]) {
			if p := str(asMap(s)["filenamePattern"]); p != "" {
				patterns = append(patterns, p)
			}
		}
		if str(ce["viewType"]) == "" || len(patterns) == 0 {
			continue
		}
		editors = append(editors, map[string]any{"viewType": ce["viewType"], "displayName": c.pkg.localize(ce["displayName"]), "filenamePatterns": patterns, "priority": str(ce["priority"])})
		c.add("customEditors", vsxConverted, c.pkg.localize(ce["displayName"]), "opens "+strings.Join(patterns, " ")+" files in a webview tab")
	}
	if len(editors) > 0 {
		c.contrib["customEditors"] = editors
	}
	var views []any
	containers := map[string]string{}
	for _, group := range asMap(contributes["viewsContainers"]) {
		for _, item := range asList(group) {
			v := asMap(item)
			containers[str(v["id"])] = c.pkg.localize(v["title"])
		}
	}
	var groups []string
	for group := range asMap(contributes["views"]) {
		groups = append(groups, group)
	}
	sort.Strings(groups)
	for _, group := range groups {
		for _, item := range asList(asMap(contributes["views"])[group]) {
			v := asMap(item)
			if str(v["id"]) == "" {
				continue
			}
			views = append(views, map[string]any{"id": v["id"], "name": c.pkg.localize(v["name"]), "type": str(v["type"]), "container": group, "containerTitle": containers[group]})
		}
	}
	if len(views) > 0 {
		c.contrib["views"] = views
		c.add("views", vsxPartial, plural(len(views), "sidebar view"), "native Sulfur sidebar containers; webview and tree providers use the extension bridge; conditional visibility and view menus are not translated")
	}
	if bytes.Contains(code, []byte("createWebviewPanel")) {
		c.add("webviews", vsxConverted, "webview panels", "Sulfur webview tabs: acquireVsCodeApi, VS Code's theme variables, its own files inlined")
	}
	if bytes.Contains(code, []byte("registerWebviewViewProvider")) {
		c.add("webviewViews", vsxConverted, "sidebar webviews", "in Sulfur's sidebar with native theme and lifecycle events")
	}
	detail := fmt.Sprintf("its web build (%s, %dKB of code and files", browser, size>>10)
	if binary > 0 {
		detail += fmt.Sprintf(", %d binary", binary)
	}
	detail += ") runs sandboxed under Sulfur's VS Code API shim; calls Sulfur lacks fail at run time, in its output channel"
	if skipped > 0 {
		detail += fmt.Sprintf("; %d files over the %dMB a conversion carries were left out", skipped, vsxWebMax>>20)
	}
	c.add("code", vsxPartial, "extension code", detail)
	// its settings' defaults, what the shim's getConfiguration answers
	defaults := map[string]any{}
	for _, cfg := range asList(contributes["configuration"]) {
		for k, p := range asMap(asMap(cfg)["properties"]) {
			if d, ok := asMap(p)["default"]; ok {
				defaults[k] = d
			}
		}
	}
	c.webDefaults = defaults
}
