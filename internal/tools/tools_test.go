package tools

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func tarball(t *testing.T) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	add := func(h *tar.Header, body string) {
		h.Size = int64(len(body))
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		tw.Write([]byte(body))
	}
	add(&tar.Header{Name: "build/", Typeflag: tar.TypeDir, Mode: 0o755}, "")
	add(&tar.Header{Name: "build/llama-server", Typeflag: tar.TypeReg, Mode: 0o755}, "#!/bin/sh\n")
	add(&tar.Header{Name: "build/libx.so.1", Typeflag: tar.TypeReg, Mode: 0o644}, "lib")
	add(&tar.Header{Name: "build/libx.so", Typeflag: tar.TypeSymlink, Linkname: "libx.so.1"}, "")
	add(&tar.Header{Name: "build/evil", Typeflag: tar.TypeSymlink, Linkname: "../../etc/passwd"}, "")
	add(&tar.Header{Name: "build/../../escape", Typeflag: tar.TypeReg, Mode: 0o644}, "no")
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestInstall(t *testing.T) {
	body := tarball(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	defer srv.Close()
	dir := filepath.Join(t.TempDir(), "llama-test")
	if err := install(fetch{dir, []string{srv.URL + "/a.tar.gz"}, 1}); err != nil {
		t.Fatal(err)
	}
	if !Ready(dir) {
		t.Fatal("not stamped ready")
	}
	st, err := os.Stat(filepath.Join(dir, "llama-server"))
	if err != nil || st.Mode()&0o100 == 0 {
		t.Fatalf("binary missing or not executable: %v", err)
	}
	if l, err := os.Readlink(filepath.Join(dir, "libx.so")); err != nil || l != "libx.so.1" {
		t.Fatalf("lib link %q %v", l, err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "evil")); err == nil {
		t.Fatal("a link out of the folder was kept")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "escape")); err == nil {
		t.Fatal("a file escaped the folder")
	}
	if _, err := os.Stat(dir + ".part"); err == nil {
		t.Fatal("the .part folder was left behind")
	}
}

func TestFailedFetch(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	dir := filepath.Join(t.TempDir(), "opencode-test")
	if err := install(fetch{dir, []string{srv.URL + "/x.tar.gz"}, 0}); err == nil {
		t.Fatal("a 404 installed")
	}
	if Ready(dir) {
		t.Fatal("stamped after a failure")
	}
}
