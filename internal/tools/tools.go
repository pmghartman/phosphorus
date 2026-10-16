// Package tools: opencode and llama-server, fetched on the model host alone
// into the model volume, pinned to upstream's releases, gone once it stops
// being the model host
package tools

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	// LlamaTag upstream's llama.cpp release
	LlamaTag = "b11284"
	// OpencodeTag upstream's opencode release
	OpencodeTag = "v1.18.34"
	retryAfter  = time.Minute
	okStamp     = ".phosphorus-ok"
)

var (
	root   = filepath.Join(util.Env("MODEL_DIR", "/models"), "tools")
	client = &http.Client{Timeout: 30 * time.Minute}
)

// Root where every fetched tool lives
func Root() string { return root }

// OpencodeHome opencode's home on the model volume, the frontend and
// phosphorus-model both mounting it
func OpencodeHome() string {
	return util.Env("OPENCODE_HOME", filepath.Join(filepath.Dir(root), "opencode"))
}

// OpencodeRun the opencode the frontend wants run by phosphorus-model, no Gen: none
type OpencodeRun struct {
	Gen  string   `json:"gen"`
	Args []string `json:"args"`
	Env  []string `json:"env"`
	Dir  string   `json:"dir"`
}

// OpencodeState phosphorus-model's answer to a run
type OpencodeState struct {
	Gen string `json:"gen"`
	Err string `json:"err,omitempty"`
}

// OpencodeRunFile the frontend's ask, read by phosphorus-model
func OpencodeRunFile() string { return filepath.Join(OpencodeHome(), "run.json") }

// OpencodeStateFile phosphorus-model's answer
func OpencodeStateFile() string { return filepath.Join(OpencodeHome(), "state.json") }

func llamaKind(gpu bool) string {
	a := map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH]
	if gpu && a == "x64" {
		return "cuda-12.8-x64"
	}
	return a
}

// LlamaDir llama-server and its libs, cuda's build when gpu and there is one
func LlamaDir(gpu bool) string {
	return filepath.Join(root, "llama-"+LlamaTag+"-"+llamaKind(gpu))
}

// OpencodeBin the opencode binary, OPENCODE_BIN overriding it
func OpencodeBin() string {
	if b := os.Getenv("OPENCODE_BIN"); b != "" {
		return b
	}
	return filepath.Join(root, "opencode-"+OpencodeTag, "opencode")
}

// Ready a tool's folder fully unpacked
func Ready(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, okStamp))
	return err == nil
}

// OpencodeReady opencode here to run
func OpencodeReady() bool {
	if os.Getenv("OPENCODE_BIN") != "" {
		_, err := os.Stat(OpencodeBin())
		return err == nil
	}
	return Ready(filepath.Dir(OpencodeBin()))
}

type fetch struct {
	dir   string
	urls  []string
	strip int
}

func llamaFetch(gpu bool) fetch {
	base := "https://github.com/ggml-org/llama.cpp/releases/download/" + LlamaTag
	k := llamaKind(gpu)
	urls := []string{fmt.Sprintf("%s/llama-%s-bin-ubuntu-%s.tar.gz", base, LlamaTag, k)}
	if strings.HasPrefix(k, "cuda") {
		urls = append(urls, fmt.Sprintf("%s/cudart-llama-%s-bin-ubuntu-%s.tar.gz", base, LlamaTag, k))
	}
	return fetch{LlamaDir(gpu), urls, 1}
}

func opencodeFetch() fetch {
	a := map[string]string{"amd64": "x64-baseline", "arm64": "arm64"}[runtime.GOARCH]
	u := fmt.Sprintf("https://github.com/anomalyco/opencode/releases/download/%s/opencode-linux-%s.tar.gz", OpencodeTag, a)
	return fetch{filepath.Dir(OpencodeBin()), []string{u}, 0}
}

// state of one tool: ready, fetching, or why it failed
type state struct {
	busy    bool
	err     string
	retryAt time.Time
}

var (
	mu     sync.Mutex
	states = map[string]*state{}
)

// Ensure both tools here, each fetched in the background once missing;
// their states by name: ready, fetching or the failure
func Ensure(gpu bool) map[string]string {
	out := map[string]string{}
	for name, f := range map[string]fetch{"llama": llamaFetch(gpu), "opencode": opencodeFetch()} {
		out[name] = ensure(f)
	}
	prune(gpu)
	return out
}

func ensure(f fetch) string {
	if Ready(f.dir) {
		return "ready"
	}
	mu.Lock()
	defer mu.Unlock()
	s := states[f.dir]
	if s == nil {
		s = &state{}
		states[f.dir] = s
	}
	if s.busy {
		return "fetching"
	}
	if time.Now().Before(s.retryAt) {
		return s.err
	}
	s.busy = true
	go func() {
		err := install(f)
		mu.Lock()
		defer mu.Unlock()
		s.busy = false
		if err != nil {
			s.err = "failed: " + err.Error()
			s.retryAt = time.Now().Add(retryAfter)
			return
		}
		s.err = ""
	}()
	return "fetching"
}

// every other version and build dropped, so an upgrade or a gpu switch
// never leaves the old one on disk
func prune(gpu bool) {
	keep := map[string]bool{filepath.Base(LlamaDir(gpu)): true, filepath.Base(filepath.Dir(OpencodeBin())): true}
	entries, _ := os.ReadDir(root)
	mu.Lock()
	defer mu.Unlock()
	for _, e := range entries {
		n := e.Name()
		base := strings.TrimSuffix(n, ".part")
		if keep[base] && (n == base || states[filepath.Join(root, base)] != nil && states[filepath.Join(root, base)].busy) {
			continue
		}
		os.RemoveAll(filepath.Join(root, n))
	}
}

// Remove every fetched tool, this host no longer the model host
func Remove() {
	mu.Lock()
	for _, s := range states {
		if s.busy {
			mu.Unlock()
			return
		}
	}
	mu.Unlock()
	if _, err := os.Stat(root); err == nil {
		os.RemoveAll(root)
	}
	os.RemoveAll(OpencodeHome())
}

// install each tarball into dir.part, renamed to dir once all are in
func install(f fetch) error {
	part := f.dir + ".part"
	os.RemoveAll(part)
	if err := os.MkdirAll(part, 0o755); err != nil {
		return err
	}
	for _, u := range f.urls {
		if err := unpack(u, part, f.strip); err != nil {
			os.RemoveAll(part)
			return err
		}
	}
	if err := os.WriteFile(filepath.Join(part, okStamp), []byte(strings.Join(f.urls, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	os.RemoveAll(f.dir)
	return os.Rename(part, f.dir)
}

func unpack(u, dir string, strip int) error {
	res, err := client.Get(u)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("%s: %s", filepath.Base(u), res.Status)
	}
	gz, err := gzip.NewReader(res.Body)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		parts := strings.Split(strings.TrimPrefix(filepath.ToSlash(h.Name), "./"), "/")
		if len(parts) <= strip {
			continue
		}
		rel := filepath.Clean(filepath.Join(parts[strip:]...))
		if rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			continue
		}
		p := filepath.Join(dir, rel)
		switch h.Typeflag {
		case tar.TypeDir:
			os.MkdirAll(p, 0o755)
		case tar.TypeSymlink:
			// links kept inside the folder, as llama's .so chains are
			if t := filepath.Join(filepath.Dir(rel), h.Linkname); filepath.IsAbs(h.Linkname) || strings.HasPrefix(filepath.Clean(t), "..") {
				continue
			}
			os.MkdirAll(filepath.Dir(p), 0o755)
			os.Remove(p)
			if err := os.Symlink(h.Linkname, p); err != nil {
				return err
			}
		case tar.TypeReg:
			os.MkdirAll(filepath.Dir(p), 0o755)
			out, err := os.OpenFile(p, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(h.Mode)&0o755|0o600)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, tr)
			out.Close()
			if err != nil {
				return err
			}
		}
	}
}
