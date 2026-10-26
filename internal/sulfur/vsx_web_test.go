package sulfur

import (
	"strings"
	"testing"
)

func TestWebBuildCarriesNativeContributionsAndResources(t *testing.T) {
	conv, m := convert(t, map[string]string{
		"extension/package.json":       `{"publisher":"pub","name":"viewer","version":"1.0.0","browser":"./out/browser.js","main":"./out/node.js","contributes":{"commands":[{"command":"viewer.open","title":"Open"}],"customEditors":[{"viewType":"viewer.custom","displayName":"Viewer","selector":[{"filenamePattern":"*.db"}]}],"configuration":{"properties":{"viewer.rows":{"default":100}}},"languages":[{"id":"demo","extensions":[".demo"]}]}}`,
		"extension/out/browser.js":     "exports.activate = () => {};",
		"extension/out/node.js":        "node-only",
		"extension/out/worker.js":      "worker",
		"extension/media/view.wasm":    "\x00asm",
		"extension/LICENSE.md":         "Original extension license",
		"extension/out/browser.js.map": "source map",
	}, VSXOptions{})
	if m["main"] != "vscode/out/browser.js" || asMap(m["sulfur"])["declarative"] != false {
		t.Fatal(m)
	}
	if conv.Files["vscode/out/worker.js"] != "worker" || conv.Binary["vscode/media/view.wasm"] == "" || conv.Files["vscode/LICENSE.md"] == "" {
		t.Fatal("worker, wasm, or license was omitted")
	}
	if conv.Files["vscode/out/node.js"] != "" || conv.Files["vscode/out/browser.js.map"] != "" {
		t.Fatal("Node entry or source map was copied")
	}
	if len(asList(asMap(m["contributes"])["languages"])) != 1 || len(asList(asMap(m["contributes"])["customEditors"])) != 1 {
		t.Fatal("native contributions or custom editor missing")
	}
	if strings.Contains(conv.Files["README.md"], "none of its own code runs") {
		t.Fatal("executable conversion described as declarative")
	}
	if r := reportOf(conv, "settings"); len(r) != 1 || r[0].Status != vsxPartial {
		t.Fatal(r)
	}
}

func TestWebBuildReservesSpaceForEntryBeforeOptionalAssets(t *testing.T) {
	conv, _ := convert(t, map[string]string{
		"extension/package.json": `{"publisher":"pub","name":"large","browser":"z.js","contributes":{"commands":[{"command":"large.open","title":"Open"}]}}`,
		"extension/z.js":         "exports.activate = () => {};",
		"extension/a.bin":        strings.Repeat("a", 24<<20),
		"extension/b.bin":        strings.Repeat("b", 24<<20),
	}, VSXOptions{})
	if conv.Files["vscode/z.js"] == "" {
		t.Fatal("entry omitted because optional assets filled the size limit")
	}
}

func TestWebViewsPreserveNativeContainersAndDependencies(t *testing.T) {
	conv, m := convert(t, map[string]string{
		"extension/package.json": `{"publisher":"pub","name":"views","browser":"web.js","extensionDependencies":["pub.helper"],"contributes":{"viewsContainers":{"activitybar":[{"id":"demo","title":"Demo"}]},"views":{"demo":[{"id":"demo.web","name":"Web","type":"webview"},{"id":"demo.tree","name":"Tree"}]}}}`,
		"extension/web.js":       `exports.activate = () => {};`,
	}, VSXOptions{})
	views := asList(asMap(m["contributes"])["views"])
	if len(views) != 2 || asMap(views[0])["containerTitle"] != "Demo" || asMap(views[0])["type"] != "webview" {
		t.Fatal(views)
	}
	if len(asList(m["extensionDependencies"])) != 1 || m["main"] != "vscode/web.js" {
		t.Fatal(m)
	}
	for _, r := range conv.Report {
		if (r.Kind == "views" || r.Kind == "viewsContainers") && r.Status == vsxSkipped {
			t.Fatal("translated sidebar views reported as skipped", r)
		}
	}
}

func TestWebBuildWithoutCommandsStillRuns(t *testing.T) {
	_, m := convert(t, map[string]string{
		"extension/package.json": `{"publisher":"pub","name":"startup","browser":"web.js"}`,
		"extension/web.js":       `exports.activate = () => {};`,
	}, VSXOptions{})
	if m["main"] != "vscode/web.js" {
		t.Fatal("browser extension discarded because it has no commands", m)
	}
}

func TestVSIXRejectsUnsafeOrDuplicateResourcePaths(t *testing.T) {
	for _, name := range []string{"extension/../../escape", "extension/C:/escape", "extension/PACKAGE.JSON"} {
		data := vsix(t, map[string]string{"extension/package.json": `{"publisher":"pub","name":"safe"}`, name: "bad"})
		if _, err := ConvertVSIX(data, VSXSource{}, VSXOptions{}); err == nil {
			t.Fatal("accepted unsafe or duplicate resource", name)
		}
	}
}
