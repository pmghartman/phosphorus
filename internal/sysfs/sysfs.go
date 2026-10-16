// Package sysfs: the pretend OS's tree, etc/ and home/ replicated, every
// host a full copy, each file's latest write winning; var/ this host's own
package sysfs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/clock"
	"github.com/pmghartman/phosphorus/internal/files"
	"github.com/pmghartman/phosphorus/internal/util"
)

// Root in [home] dir's home/, out of every user's reach
var Root = filepath.Join(files.HomeRoot, "sys")

var relRe = regexp.MustCompile(`^(etc|home)(/[a-z0-9][a-z0-9._-]{0,63}){1,5}\.json$`)

// ValidRel a replicated path
func ValidRel(rel string) bool { return relRe.MatchString(rel) }

// File one entry: a stamp and data, or a tombstone
type File struct {
	At   float64         `json:"at"`
	Gone bool            `json:"gone,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

// MarshalJSON keeps data present even when null, as JS's {at, data}
func (f File) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteString(`{"at":`)
	b.WriteString(util.JSNum(f.At))
	if f.Gone {
		b.WriteString(`,"gone":true}`)
		return b.Bytes(), nil
	}
	b.WriteString(`,"data":`)
	if len(f.Data) == 0 {
		b.WriteString("null")
	} else {
		b.Write(f.Data)
	}
	b.WriteString("}")
	return b.Bytes(), nil
}

// PeerSys a peer's published digest
type PeerSys struct {
	Host   string
	Digest string
}

var (
	mu         sync.RWMutex
	tree       = map[string]File{}
	oldest     = map[string]bool{}
	watchers   []func(string)
	digestMemo string

	// PeerIPs and Peers from mesh, set at startup
	PeerIPs = func() map[string]string { return nil }
	Peers   = func() []PeerSys { return nil }

	synced   = map[string]string{}
	syncedMu sync.Mutex
	pullMu   sync.Mutex
	pulling  chan struct{}
)

func parseFile(b []byte) (File, bool) {
	var raw map[string]json.RawMessage
	if json.Unmarshal(b, &raw) != nil || raw == nil {
		return File{}, false
	}
	var f File
	if json.Unmarshal(raw["at"], &f.At) != nil {
		return File{}, false
	}
	if g, ok := raw["gone"]; ok && string(bytes.TrimSpace(g)) == "true" {
		f.Gone = true
	}
	d, has := raw["data"]
	if has {
		f.Data = d
	}
	return f, valid(f, has)
}

func valid(f File, hasData bool) bool {
	if math.IsNaN(f.At) || math.IsInf(f.At, 0) || f.At > float64(util.Now()+60000) {
		return false
	}
	return f.Gone || hasData
}

func load(dir, rel string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		r := e.Name()
		if rel != "" {
			r = rel + "/" + e.Name()
		}
		if e.IsDir() {
			if r != "var" {
				load(filepath.Join(dir, e.Name()), r)
			}
		} else if relRe.MatchString(r) {
			b, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			if f, ok := parseFile(b); ok {
				tree[r] = f
			}
		}
	}
}

func put(rel string, f File) {
	mu.Lock()
	tree[rel] = f
	digestMemo = ""
	ws := append([]func(string){}, watchers...)
	mu.Unlock()
	for _, w := range ws {
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[sys] watcher on %s: %v", rel, r)
				}
			}()
			w(rel)
		}()
	}
	clock.MarkHot()
	abs := filepath.Join(Root, rel)
	os.MkdirAll(filepath.Dir(abs), 0o700)
	util.WriteFileAtomic(abs, util.Marshal(f))
}

func stampOf(rel string) float64 {
	mu.RLock()
	defer mu.RUnlock()
	return tree[rel].At
}

func nextAt(rel string) float64 {
	return math.Max(float64(util.Now()), stampOf(rel)+1)
}

// Read a live file's data, nil when absent or gone
func Read(rel string) json.RawMessage {
	mu.RLock()
	defer mu.RUnlock()
	f, ok := tree[rel]
	if !ok || f.Gone {
		return nil
	}
	if len(f.Data) == 0 || string(f.Data) == "null" {
		return nil
	}
	return f.Data
}

// ReadInto unmarshals a live file, false when absent
func ReadInto(rel string, v any) bool {
	d := Read(rel)
	if d == nil {
		return false
	}
	return json.Unmarshal(d, v) == nil
}

// Write a file, the oldest-wins ones never overwritten
func Write(rel string, data any) {
	if !relRe.MatchString(rel) {
		panic("bad sys path " + rel)
	}
	mu.RLock()
	old := oldest[rel]
	mu.RUnlock()
	if old && Read(rel) != nil {
		return
	}
	put(rel, File{At: nextAt(rel), Data: util.Marshal(data)})
}

// Remove a live file, a tombstone left
func Remove(rel string) {
	if Read(rel) != nil {
		put(rel, File{At: nextAt(rel), Gone: true})
	}
}

// List live files under a dir, rel to it
func List(dir string) []string {
	pre := dir + "/"
	mu.RLock()
	defer mu.RUnlock()
	out := []string{}
	for r, f := range tree {
		if strings.HasPrefix(r, pre) && !f.Gone && len(f.Data) > 0 && string(f.Data) != "null" {
			out = append(out, r[len(pre):])
		}
	}
	sort.Strings(out)
	return out
}

// Stamp a file's stamp, 0 when absent
func Stamp(rel string) float64 { return stampOf(rel) }

// Stamps every rel and its stamp
func Stamps() map[string]float64 {
	mu.RLock()
	defer mu.RUnlock()
	out := make(map[string]float64, len(tree))
	for r, f := range tree {
		out[r] = f.At
	}
	return out
}

// Digest every rel and stamp in one hash
func Digest() string {
	mu.Lock()
	defer mu.Unlock()
	if digestMemo == "" {
		rels := make([]string, 0, len(tree))
		for r := range tree {
			rels = append(rels, r)
		}
		sort.Strings(rels)
		h := sha256.New()
		for _, r := range rels {
			h.Write([]byte(r + "\t" + util.JSNum(tree[r].At) + "\n"))
		}
		digestMemo = hex.EncodeToString(h.Sum(nil))[:32]
	}
	return digestMemo
}

// Dump the whole tree, or only the files asked for
func Dump(rels []string) map[string]File {
	mu.RLock()
	defer mu.RUnlock()
	out := map[string]File{}
	if rels == nil {
		for r, f := range tree {
			out[r] = f
		}
		return out
	}
	for _, r := range rels {
		if f, ok := tree[r]; ok {
			out[r] = f
		}
	}
	return out
}

func wins(rel string, at float64) bool {
	mu.RLock()
	old := oldest[rel]
	mu.RUnlock()
	if old && Read(rel) != nil {
		return at < stampOf(rel)
	}
	return at > stampOf(rel)
}

// Merge a peer's files, true when anything changed
func Merge(got map[string]json.RawMessage) bool {
	changed := false
	rels := make([]string, 0, len(got))
	for r := range got {
		rels = append(rels, r)
	}
	sort.Strings(rels)
	for _, rel := range rels {
		f, ok := parseFile(got[rel])
		if !relRe.MatchString(rel) || !ok || !wins(rel, f.At) {
			continue
		}
		if f.Gone {
			put(rel, File{At: f.At, Gone: true})
		} else {
			put(rel, File{At: f.At, Data: f.Data})
		}
		changed = true
	}
	return changed
}

func wanted(st map[string]any) []string {
	out := []string{}
	for rel, v := range st {
		at, ok := v.(float64)
		if relRe.MatchString(rel) && ok && !math.IsInf(at, 0) && at <= float64(util.Now()+60000) && wins(rel, at) {
			out = append(out, rel)
		}
	}
	sort.Strings(out)
	return out
}

// Local var/<rel>: this host's own
func Local(rel string) string {
	abs := filepath.Join(Root, "var", rel)
	os.MkdirAll(filepath.Dir(abs), 0o700)
	return abs
}

const pullBatch = 40

// Pull every peer whose digest differs, one pull at a time
func Pull() {
	pullMu.Lock()
	if pulling != nil {
		ch := pulling
		pullMu.Unlock()
		<-ch
		return
	}
	ch := make(chan struct{})
	pulling = ch
	pullMu.Unlock()
	defer func() {
		pullMu.Lock()
		pulling = nil
		pullMu.Unlock()
		close(ch)
	}()
	pullOnce()
}

func pullOnce() {
	ips := PeerIPs()
	var wg sync.WaitGroup
	for _, p := range Peers() {
		ip := ips[p.Host]
		syncedMu.Lock()
		done := p.Digest == synced[p.Host]
		syncedMu.Unlock()
		if ip == "" || p.Digest == Digest() || done {
			continue
		}
		wg.Add(1)
		go func(p PeerSys, ip string) {
			defer wg.Done()
			s, err := util.RequestJSON(util.Req{Host: ip, Port: util.FrontendPort, Path: "/api/sys/stamps", Timeout: 5 * time.Second})
			if err != nil || s.Status != 200 || s.Body == nil {
				return
			}
			var st map[string]any
			if json.Unmarshal(s.Body, &st) != nil || st == nil {
				return
			}
			want := wanted(st)
			for i := 0; i < len(want); i += pullBatch {
				end := i + pullBatch
				if end > len(want) {
					end = len(want)
				}
				rels := []string{}
				for _, r := range want[i:end] {
					if at, _ := st[r].(float64); wins(r, at) {
						rels = append(rels, r)
					}
				}
				if len(rels) == 0 {
					continue
				}
				q := url.Values{"rels": {strings.Join(rels, ",")}}
				r, err := util.RequestJSON(util.Req{Host: ip, Port: util.FrontendPort, Path: "/api/sys/sync?" + q.Encode(), Timeout: 5 * time.Second})
				if err != nil || r.Status != 200 {
					return
				}
				var got map[string]json.RawMessage
				if json.Unmarshal(r.Body, &got) == nil {
					Merge(got)
				}
			}
			syncedMu.Lock()
			synced[p.Host] = p.Digest
			syncedMu.Unlock()
		}(p, ip)
	}
	wg.Wait()
}

// OldestWins a path whose first write stays
func OldestWins(rel string) {
	mu.Lock()
	oldest[rel] = true
	mu.Unlock()
}

// Watch every change, local or a peer's
func Watch(fn func(string)) {
	mu.Lock()
	watchers = append(watchers, fn)
	mu.Unlock()
}

var startOnce sync.Once

// Start the tree loaded, pulled every second
func Start() {
	startOnce.Do(func() {
		mu.Lock()
		load(Root, "")
		mu.Unlock()
		go func() {
			for range time.Tick(time.Second) {
				Pull()
			}
		}()
	})
}

// Load without the pull loop, for tests and the cli
func Load() {
	mu.Lock()
	load(Root, "")
	mu.Unlock()
}
