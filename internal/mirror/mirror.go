// Package mirror: home files kept on every host, one sys entry per file
// (etc/mirror/<id>), every other host pulling the latest copy
package mirror

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/files"
	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/util"
)

// Max small files only
const (
	Max    = 32 * 1024 * 1024
	tickMS = 3000
	dir    = "etc/mirror"
)

type entry struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	From string `json:"from"`
}

type appliedRec struct {
	At   float64 `json:"at"`
	Path string  `json:"path"`
}

var (
	appliedFile string
	mu          sync.Mutex
	applied     = map[string]appliedRec{}
	self        = os.Getenv("SELF_HOST")
	busy        bool
	idRe        = regexp.MustCompile(`^[0-9a-f]{24}$`)
)

func idOf(rel string) string {
	h := sha256.Sum256([]byte(rel))
	return hex.EncodeToString(h[:])[:24]
}

func entryRel(id string) string { return dir + "/" + id + ".json" }

func share() *files.Share { return files.ShareOf("home") }

func saveApplied() { util.WriteJSONAtomic(appliedFile, applied) }

func read(rel string) *entry {
	var e entry
	if !sysfs.ReadInto(rel, &e) {
		return nil
	}
	return &e
}

// IsMirrored a home path kept on every host
func IsMirrored(rel string) bool { return read(entryRel(idOf(rel))) != nil }

func sizeOf(rel string) int64 {
	sh := share()
	if sh == nil {
		return -1
	}
	abs := files.DownloadPath(sh, rel)
	if abs == "" {
		return -1
	}
	st, err := os.Stat(abs)
	if err != nil {
		return -1
	}
	return st.Size()
}

// Mark this host's copy the one every other takes
func Mark(rel string) (int, any) {
	size := sizeOf(rel)
	if size < 0 {
		return 404, map[string]any{"error": "no such file"}
	}
	if size > Max {
		return 413, map[string]any{"error": "over 32MB, kept on one host"}
	}
	id := idOf(rel)
	sysfs.Write(entryRel(id), entry{rel, size, self})
	mu.Lock()
	applied[id] = appliedRec{sysfs.Stamp(entryRel(id)), rel}
	saveApplied()
	mu.Unlock()
	return 200, map[string]any{"ok": true, "all": true}
}

// Unmark no longer on every host
func Unmark(rel string) (int, any) {
	sysfs.Remove(entryRel(idOf(rel)))
	return 200, map[string]any{"ok": true, "all": false}
}

// Touched a write, rename or delete in the home, a mirrored entry following
func Touched(op, rel, to string) {
	switch op {
	case "delete":
		for _, f := range sysfs.List(dir) {
			id := strings.TrimSuffix(f, ".json")
			e := read(entryRel(id))
			if e != nil && (e.Path == rel || strings.HasPrefix(e.Path, rel+"/")) {
				sysfs.Remove(entryRel(id))
			}
		}
	case "rename":
		if IsMirrored(rel) {
			Unmark(rel)
			Mark(to)
		}
	default:
		if IsMirrored(rel) {
			if s, _ := Mark(rel); s != 200 {
				Unmark(rel)
			}
		}
	}
}

// Serve a peer's GET /internal/mirror/<id>, this host's copy when it's the latest
func Serve(id string, w http.ResponseWriter) {
	var abs string
	if idRe.MatchString(id) {
		if e := read(entryRel(id)); e != nil && e.From == self {
			if sh := share(); sh != nil {
				abs = files.DownloadPath(sh, e.Path)
			}
		}
	}
	f, err := os.Open(abs)
	if abs == "" || err != nil {
		w.WriteHeader(404)
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	w.WriteHeader(200)
	io.Copy(w, f)
}

func fetchTo(ip string, port int, id, tmp string) bool {
	c := &http.Client{Timeout: 60 * time.Second, Transport: &http.Transport{Proxy: nil}}
	res, err := c.Get(fmt.Sprintf("http://%s:%d/internal/mirror/%s", ip, port, id))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		io.Copy(io.Discard, res.Body)
		return false
	}
	out, err := os.Create(tmp)
	if err != nil {
		return false
	}
	_, err = io.Copy(out, res.Body)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err == nil
}

func tick(ipOf func(string) string, port int) {
	sh := share()
	mu.Lock()
	if busy || sh == nil {
		mu.Unlock()
		return
	}
	busy = true
	mu.Unlock()
	defer func() {
		mu.Lock()
		saveApplied()
		busy = false
		mu.Unlock()
	}()
	live := map[string]bool{}
	for _, f := range sysfs.List(dir) {
		id := strings.TrimSuffix(f, ".json")
		live[id] = true
		e := read(entryRel(id))
		at := sysfs.Stamp(entryRel(id))
		mu.Lock()
		a, had := applied[id]
		mu.Unlock()
		if e == nil || (had && a.At >= at) {
			continue
		}
		if e.From == self {
			mu.Lock()
			applied[id] = appliedRec{at, e.Path}
			mu.Unlock()
			continue
		}
		ip := ipOf(e.From)
		files.MakeParents(*sh, e.Path)
		if ip == "" {
			continue
		}
		abs := files.SafePath(*sh, e.Path, false)
		if abs == "" {
			continue
		}
		tmp := filepath.Join(filepath.Dir(abs), ".phosphorus-upload-mirror-"+id)
		if !fetchTo(ip, port, id, tmp) {
			os.Remove(tmp)
			continue
		}
		if err := os.Rename(tmp, abs); err != nil {
			os.Remove(tmp)
			continue
		}
		mu.Lock()
		applied[id] = appliedRec{at, e.Path}
		mu.Unlock()
		if had && a.Path != e.Path {
			if old := files.SafePath(*sh, a.Path, true); old != "" {
				os.Remove(old)
			}
		}
	}
	mu.Lock()
	defer mu.Unlock()
	for id, a := range applied {
		if live[id] || sysfs.Stamp(entryRel(id)) <= a.At {
			continue
		}
		if abs := files.SafePath(*sh, a.Path, true); abs != "" {
			os.Remove(abs)
		}
		delete(applied, id)
	}
}

// Start the pull loop
func Start(ipOf func(string) string, port int) {
	appliedFile = sysfs.Local("mirror-applied.json", "")
	util.ReadJSON(appliedFile, &applied)
	if applied == nil {
		applied = map[string]appliedRec{}
	}
	go func() {
		for range time.Tick(tickMS * time.Millisecond) {
			tick(ipOf, port)
		}
	}()
}
