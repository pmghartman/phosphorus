package sulfur

import (
	"archive/zip"
	"bufio"
	"bytes"
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
