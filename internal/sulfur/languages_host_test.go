package sulfur

import (
	"archive/zip"
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// the test binary itself as a language server that echoes each request's params back
func TestHelperLSPEcho(t *testing.T) {
	if os.Getenv("SULFUR_TEST_LSP_ECHO") != "1" {
		return
	}
	r := bufio.NewReader(os.Stdin)
	for {
		size := -1
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				os.Exit(0)
			}
			if line == "\r\n" {
				break
			}
			if strings.HasPrefix(strings.ToLower(line), "content-length:") {
				size, _ = strconv.Atoi(strings.TrimSpace(line[len("content-length:"):]))
			}
		}
		data := make([]byte, size)
		io.ReadFull(r, data)
		var m struct {
			ID     int             `json:"id"`
			Params json.RawMessage `json:"params"`
		}
		json.Unmarshal(data, &m)
		reply, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": m.Params})
		os.Stdout.WriteString("Content-Length: " + strconv.Itoa(len(reply)) + "\r\n\r\n" + string(reply))
	}
}

func testAdapter(t *testing.T) (*adapter, *bytes.Buffer) {
	t.Helper()
	var out bytes.Buffer
	a := newAdapter(filepath.Join(t.TempDir(), "extensions"), &out, io.Discard)
	a.fetch = func(string) ([]byte, error) { return nil, errors.New("network accessed") }
	t.Cleanup(a.cancel)
	return a, &out
}

func TestMetadataReadsNeedAServerReturnedURIAndNeverEnableWrites(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	virtual := "csharp:/project.csproj/decompiled/Engine.cs"
	if !docAllowed(fileURI(filepath.Join(root, "App.cs")), "textDocument/didOpen", root, nil) {
		t.Error("a file in the project refused")
	}
	if docAllowed(fileURI(filepath.Join(filepath.Dir(root), "outside.cs")), "textDocument/didOpen", root, nil) {
		t.Error("a file outside the project allowed")
	}
	if docAllowed(virtual, "csharp/metadata", root, nil) {
		t.Error("a virtual document no server returned allowed")
	}
	seen := map[string]bool{virtual: true}
	for _, m := range []string{"csharp/metadata", "textDocument/semanticTokens/full", "textDocument/hover"} {
		if !docAllowed(virtual, m, root, seen) {
			t.Errorf("%s refused on a returned document", m)
		}
	}
	for _, m := range []string{"textDocument/didOpen", "textDocument/didChange", "textDocument/rename", "textDocument/formatting"} {
		if docAllowed(virtual, m, root, seen) {
			t.Errorf("%s allowed on a virtual document", m)
		}
	}
}

func TestSymlinkOutOfTheProjectIsRefused(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	root, outside := filepath.Join(base, "project"), filepath.Join(base, "outside")
	os.MkdirAll(root, 0o755)
	os.MkdirAll(outside, 0o755)
	if os.Symlink(outside, filepath.Join(root, "link")) != nil {
		t.Skip("no symlinks here")
	}
	if docAllowed(fileURI(filepath.Join(root, "link", "x.go")), "textDocument/didOpen", root, nil) {
		t.Error("a path through a symlink out of the project allowed")
	}
}

func TestStatusIsOfflineOptionalAndExactlyTen(t *testing.T) {
	a, out := testAdapter(t)
	if err := a.serve(LanguageRequest{Op: "status"}, strings.NewReader("")); err != nil {
		t.Fatal(err)
	}
	var m struct {
		Extensions []struct {
			ID        string `json:"id"`
			Installed bool   `json:"installed"`
		} `json:"extensions"`
	}
	if err := json.Unmarshal(out.Bytes(), &m); err != nil || len(m.Extensions) != 10 {
		t.Fatalf("status = %v %s", err, out.String())
	}
	for _, x := range m.Extensions {
		if x.Installed {
			t.Errorf("%s installed", x.ID)
		}
	}
	if _, err := os.Stat(a.home); err == nil {
		t.Error("status created the extensions folder")
	}
}

func TestEnableDisableUninstallAreScopedAndKeepExternalBinaries(t *testing.T) {
	a, _ := testAdapter(t)
	target := filepath.Join(a.home, "cpp")
	os.MkdirAll(target, 0o755)
	binary := filepath.Join(t.TempDir(), "clangd")
	os.WriteFile(binary, []byte("external"), 0o755)
	writeManifest(filepath.Join(target, "manifest.json"), map[string]any{"enabled": true, "external": true, "entry": binary})
	run := func(op string) {
		t.Helper()
		if err := a.serve(LanguageRequest{Op: op, Language: "cpp"}, strings.NewReader("")); err != nil {
			t.Fatal(op, err)
		}
	}
	run("disable")
	if a.load("cpp")["enabled"] != false {
		t.Error("not disabled")
	}
	run("enable")
	if a.load("cpp")["enabled"] != true {
		t.Error("not enabled")
	}
	run("uninstall")
	if _, err := os.Stat(target); err == nil {
		t.Error("not uninstalled")
	}
	if b, _ := os.ReadFile(binary); string(b) != "external" {
		t.Error("the external binary was touched")
	}
}

func TestFailedInstallKeepsTheWorkingVersionAndReleasesTheLock(t *testing.T) {
	a, _ := testAdapter(t)
	target := filepath.Join(a.home, "python")
	os.MkdirAll(target, 0o755)
	writeManifest(filepath.Join(target, "manifest.json"), map[string]any{"enabled": true, "version": "old"})
	a.executable = func(string) (string, error) { return "", errors.New("registry offline") }
	err := a.serve(LanguageRequest{Op: "install", Language: "python"}, strings.NewReader(""))
	if err == nil || !strings.Contains(err.Error(), "registry offline") {
		t.Fatalf("err = %v", err)
	}
	if a.load("python")["version"] != "old" {
		t.Error("the working install was replaced")
	}
	if _, err := os.Stat(filepath.Join(a.home, ".lock-python")); err == nil {
		t.Error("lock kept")
	}
	if ents, _ := os.ReadDir(a.home); len(ents) != 1 {
		t.Errorf("staging left behind: %v", ents)
	}
}

func TestConcurrentInstallIsRefused(t *testing.T) {
	a, _ := testAdapter(t)
	os.MkdirAll(filepath.Join(a.home, ".lock-python"), 0o755)
	err := a.serve(LanguageRequest{Op: "install", Language: "python"}, strings.NewReader(""))
	if err == nil || !strings.Contains(err.Error(), "Another operation") {
		t.Fatalf("err = %v", err)
	}
}

func TestArchiveTraversalIsRefused(t *testing.T) {
	a, _ := testAdapter(t)
	var z bytes.Buffer
	w := zip.NewWriter(&z)
	f, _ := w.Create("../escaped")
	f.Write([]byte("bad"))
	w.Close()
	a.fetch = func(string) ([]byte, error) { return z.Bytes(), nil }
	dest := filepath.Join(a.home, "stage")
	os.MkdirAll(dest, 0o755)
	err := a.unpack("https://example.test/server.zip", dest, map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(a.home, "escaped")); err == nil {
		t.Error("a file escaped")
	}
}

func TestDownloadsNeedHTTPS(t *testing.T) {
	a := newAdapter(t.TempDir(), io.Discard, io.Discard)
	defer a.cancel()
	if _, err := a.httpFetch("http://example.test/x"); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("err = %v", err)
	}
}

func TestDisabledServerAndMissingRootNeverSpawn(t *testing.T) {
	a, _ := testAdapter(t)
	a.command = func(langItem, map[string]any, LanguageRequest) ([]string, error) {
		t.Fatal("spawned")
		return nil, nil
	}
	item, _ := langByID("python")
	if err := a.launch(item, nil, LanguageRequest{Root: t.TempDir()}, strings.NewReader("")); err == nil || !strings.Contains(err.Error(), "not installed and enabled") {
		t.Errorf("err = %v", err)
	}
	if err := a.launch(item, map[string]any{"enabled": true}, LanguageRequest{Root: "relative/path"}, strings.NewReader("")); err == nil || !strings.Contains(err.Error(), "absolute project") {
		t.Errorf("err = %v", err)
	}
	if err := a.launch(item, map[string]any{"enabled": true}, LanguageRequest{Root: filepath.Join(t.TempDir(), "nope")}, strings.NewReader("")); err == nil {
		t.Error("a missing folder launched")
	}
}

func TestLaunchCommandsUseNoShellAndKeepConfigPaths(t *testing.T) {
	a, _ := testAdapter(t)
	cpp, _ := langByID("cpp")
	args, err := a.serverCommand(cpp, map[string]any{"entry": "clangd"}, LanguageRequest{BuildDirectory: "D:/space & data/Release"})
	if err != nil || args[len(args)-1] != "--compile-commands-dir=D:/space & data/Release" {
		t.Fatalf("args = %v %v", args, err)
	}
	a.executable = func(string) (string, error) { return "node", nil }
	ts, _ := langByID("typescript")
	args, _ = a.serverCommand(ts, map[string]any{"entry": "cli.mjs"}, LanguageRequest{})
	if !strings.Contains(strings.Join(args, " "), "--tsserver-path") || strings.Contains(strings.Join(args, " "), "npx") {
		t.Fatalf("args = %v", args)
	}
}

func TestNewestVersion(t *testing.T) {
	if v := newest([]string{"6.0.9", "6.10.1", "6.2.0"}); v != "6.10.1" {
		t.Errorf("newest = %s", v)
	}
	if !verLess(verOf("v22.22.1"), []int{22, 22, 2}) || verLess(verOf("v24.0.0"), []int{22, 22, 2}) {
		t.Error("node version compare")
	}
}

func TestUTF8DocumentsSurviveTheTransport(t *testing.T) {
	root := filepath.Join(t.TempDir(), "project-café")
	os.MkdirAll(root, 0o755)
	a, _ := testAdapter(t)
	os.MkdirAll(filepath.Join(a.home, "csharp"), 0o755)
	writeManifest(filepath.Join(a.home, "csharp", "manifest.json"), map[string]any{"enabled": true})
	t.Setenv("SULFUR_TEST_LSP_ECHO", "1")
	a.command = func(langItem, map[string]any, LanguageRequest) ([]string, error) {
		return []string{os.Args[0], "-test.run=TestHelperLSPEcho"}, nil
	}
	inR, inW := io.Pipe()
	pr, pw := io.Pipe()
	a.out = pw
	item, _ := langByID("csharp")
	done := make(chan error, 1)
	go func() { done <- a.launch(item, a.load("csharp"), LanguageRequest{Root: root}, inR); pw.Close() }()
	lines := bufio.NewScanner(pr)
	lines.Buffer(make([]byte, 1<<16), 1<<24)
	next := func(pred func(map[string]any) bool) map[string]any {
		t.Helper()
		for lines.Scan() {
			var m map[string]any
			if json.Unmarshal(lines.Bytes(), &m) != nil {
				continue
			}
			if m["_sulfur"] == "error" {
				t.Fatal(m["error"])
			}
			if pred(m) {
				return m
			}
		}
		t.Fatal("output ended")
		return nil
	}
	next(func(m map[string]any) bool { return m["_sulfur"] == "ready" })
	resolved, _ := filepath.EvalSymlinks(root)
	uri := fileURI(filepath.Join(resolved, "Type-π-😀.cs"))
	for seq, method := range []string{"textDocument/didOpen", "textDocument/didChange"} {
		id := seq + 1
		text := "\ufeffusing System;\r\n// café π 😀 漢字\r\nclass C {}\r\n" + strings.Repeat(" ", id)
		params := map[string]any{"textDocument": map[string]any{"uri": uri, "version": id}}
		if id == 1 {
			params["textDocument"].(map[string]any)["text"] = text
		} else {
			params["contentChanges"] = []any{map[string]any{"text": text}}
		}
		msg, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		inW.Write(append(msg, '\n'))
		got := next(func(m map[string]any) bool { return m["id"] == float64(id) })
		want, _ := json.Marshal(params)
		have, _ := json.Marshal(got["result"])
		if string(want) != string(have) {
			t.Fatalf("%s came back as\n%s\nwant\n%s", method, have, want)
		}
	}
	// a document outside the project ends the session with an error
	bad, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 9, "method": "textDocument/didOpen", "params": map[string]any{"textDocument": map[string]any{"uri": fileURI(filepath.Join(filepath.Dir(resolved), "outside.cs"))}}})
	inW.Write(append(bad, '\n'))
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "outside the project") {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the session outlived a document outside the project")
	}
}

// a converted extension's server: its package for this platform fetched (the sha256 checked),
// its entry found under this platform's name, listed, launched through the IPC bridge
func TestConvertedServerInstall(t *testing.T) {
	a, out := testAdapter(t)
	a.executable = func(name string) (string, error) { return "/bin/" + name, nil }
	var pkg bytes.Buffer
	zw := zip.NewWriter(&pkg)
	for _, name := range []string{"extension/package.json", "extension/dist/server.js", "extension/server/bin/demo-ls"} {
		w, _ := zw.Create(name)
		w.Write([]byte("x"))
	}
	zw.Close()
	base := VSXRegistry() + "/pub/demo/1.0.0/" + vsxPlatform() + "/file/pub.demo-1.0.0"
	sum := "0"
	a.fetch = func(u string) ([]byte, error) {
		switch u {
		case base + ".vsix":
			return pkg.Bytes(), nil
		case base + ".sha256":
			return []byte(sum + "  pub.demo-1.0.0.vsix\n"), nil
		}
		return nil, errors.New("fetched " + u)
	}
	// each operation on an adapter of its own, its client never going away meanwhile
	op := func(req LanguageRequest) error {
		b := newAdapter(a.home, out, io.Discard)
		b.fetch, b.executable = a.fetch, a.executable
		in, w := io.Pipe()
		defer w.Close()
		defer b.cancel()
		return b.serve(req, in)
	}
	install := func(id string, s *VSXServer) error {
		return op(LanguageRequest{Op: "install", Language: id, Server: s})
	}
	node := &VSXServer{Name: "Demo", Runtime: "node", Entry: "extension/dist/server.js", Extensions: []string{"demo"}, LanguageIDs: map[string]string{"demo": "demo"},
		Downloads: map[string]string{vsxPlatform(): base + ".vsix", "web": "https://elsewhere.example/x.vsix"}}
	if err := install("vsx.pub.demo", node); err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatal("a package not matching its sha256 installed:", err)
	}
	h := sha256Hex(pkg.Bytes())
	sum = h
	if err := install("vsx.pub.demo", node); err != nil {
		t.Fatal(err)
	}
	m := a.load("vsx.pub.demo")
	if m["custom"] != true || m["transport"] != "ipc" || m["entry"] != "extension/dist/server.js" || m["sha256"] != h {
		t.Fatal(m)
	}
	if _, err := os.Stat(filepath.Join(a.home, "vsx.pub.demo", ipcBridgeName)); err != nil {
		t.Fatal("no bridge", err)
	}
	argv, err := a.serverCommand(langItem{ID: "vsx.pub.demo", Custom: true}, m, LanguageRequest{})
	if err != nil || len(argv) != 3 || argv[0] != "/bin/node" || filepath.Base(argv[1]) != ipcBridgeName || !strings.HasSuffix(filepath.ToSlash(argv[2]), "vsx.pub.demo/extension/dist/server.js") {
		t.Fatal(argv, err)
	}
	// a native one converted from a Windows package, installed where it has no .exe
	native := &VSXServer{Name: "Demo LS", Runtime: "binary", Entry: "extension/server/bin/demo-ls.exe", Extensions: []string{"demo"}, Downloads: map[string]string{vsxPlatform(): base + ".vsix"}}
	if err := install("vsx.pub.native", native); err != nil {
		t.Fatal(err)
	}
	if m := a.load("vsx.pub.native"); m["entry"] != "extension/server/bin/demo-ls" || m["transport"] != "stdio" {
		t.Fatal(m)
	}
	out.Reset()
	op(LanguageRequest{Op: "status"})
	var status struct {
		Extensions []map[string]any `json:"extensions"`
	}
	json.Unmarshal(out.Bytes(), &status)
	n := 0
	for _, e := range status.Extensions {
		if e["custom"] == true && e["installed"] == true && e["enabled"] == true {
			n++
		}
	}
	if n != 2 {
		t.Fatal(status.Extensions)
	}
	// only Open VSX's packages, and a converted id only
	if err := install("vsx.pub.other", &VSXServer{Runtime: "node", Entry: "extension/x.js", Downloads: map[string]string{vsxPlatform(): "https://elsewhere.example/x.vsix"}}); err == nil {
		t.Error("a package from elsewhere installed")
	}
	if err := install("../../evil", node); err == nil {
		t.Error("an id outside the home taken")
	}
	if err := op(LanguageRequest{Op: "uninstall", Language: "vsx.pub.demo"}); err != nil || a.load("vsx.pub.demo") != nil {
		t.Fatal("not uninstalled", err)
	}
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// a converted server's initialize: its own client's options filled in with where it's installed,
// under the page's own
func TestWithInitOptions(t *testing.T) {
	body := []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"initializationOptions":{"l10nPath":"page"},"rootUri":null}}`)
	folder := filepath.Join(t.TempDir(), "vsx.pub.demo", "extension")
	out := withInitOptions(body, map[string]any{"l10nPath": "${extensionPath}/dist/l10n", "icons": "${extensionPath}/media"}, folder)
	var req struct {
		Params struct {
			InitializationOptions map[string]string `json:"initializationOptions"`
		} `json:"params"`
	}
	if err := json.Unmarshal(out, &req); err != nil {
		t.Fatal(err)
	}
	if o := req.Params.InitializationOptions; o["l10nPath"] != "page" || o["icons"] != filepath.Join(folder, "media") {
		t.Fatal(o)
	}
	if string(withInitOptions(body, nil, folder)) != string(body) {
		t.Fatal("changed without options")
	}
}
