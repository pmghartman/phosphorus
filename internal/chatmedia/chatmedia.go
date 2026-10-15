// Package chatmedia: chat attachments, kept on the host they were sent to,
// pulled by any other host on first view and cached, oldest dropped past the cap
package chatmedia

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	dir      string
	MaxFile  = int64(util.EnvInt("CHAT_MEDIA_MAX_MB", 25)) * 1024 * 1024
	maxTotal = int64(util.EnvInt("CHAT_MEDIA_TOTAL_MB", 1024)) * 1024 * 1024
	idRe     = regexp.MustCompile(`^[0-9a-f]{32}$`)
	hostRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	typeRe   = regexp.MustCompile(`^[\w.+-]+/[\w.+-]+$`)
	inline   = map[string]bool{
		"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/avif": true,
		"video/mp4": true, "video/webm": true, "video/ogg": true,
		"audio/mpeg": true, "audio/ogg": true, "audio/wav": true, "audio/webm": true, "audio/mp4": true, "audio/aac": true, "audio/flac": true,
		"application/pdf": true, "text/plain": true,
	}
)

const maxFiles = 8

// Init var/chat/media, the older state/chat-media moved in once
func Init() {
	dir = sysfs.Local("chat/media", filepath.Join(util.Env("STATE_DIR", "/state"), "chat-media"))
	os.MkdirAll(dir, 0o755)
}

func where(host, id string) string { return filepath.Join(dir, host, id) }

// Valid a host and id
func Valid(host, id string) bool { return hostRe.MatchString(host) && idRe.MatchString(id) }

// Meta a stored file's name, type and size
type Meta struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Size int64  `json:"size"`
}

func meta(host, id string) *Meta {
	if !Valid(host, id) {
		return nil
	}
	var m Meta
	if !util.ReadJSON(where(host, id)+".json", &m) {
		return nil
	}
	return &m
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// Clean a message's attachments as peers and browsers hand them over
func Clean(list any) []map[string]any {
	arr, ok := list.([]any)
	if !ok {
		return nil
	}
	out := []map[string]any{}
	for _, x := range arr {
		f := util.Obj(x)
		h, _ := f["host"].(string)
		id, _ := f["id"].(string)
		if f == nil || !Valid(h, id) {
			continue
		}
		if len(out) == maxFiles {
			break
		}
		name := util.Str(f["name"])
		if name == "" {
			name = "file"
		}
		size := 0.0
		if s, ok := f["size"].(float64); ok {
			size = s
		}
		out = append(out, map[string]any{"host": h, "id": id, "name": clip(name, 200), "type": clip(util.Str(f["type"]), 100), "size": size})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

var pruneMu sync.Mutex

func prune() {
	pruneMu.Lock()
	defer pruneMu.Unlock()
	type f struct {
		file string
		size int64
		at   time.Time
	}
	all := []f{}
	var total int64
	hosts, _ := os.ReadDir(dir)
	for _, h := range hosts {
		if !h.IsDir() {
			continue
		}
		ents, _ := os.ReadDir(filepath.Join(dir, h.Name()))
		for _, e := range ents {
			if !idRe.MatchString(e.Name()) {
				continue
			}
			p := filepath.Join(dir, h.Name(), e.Name())
			if st, err := os.Stat(p); err == nil {
				all = append(all, f{p, st.Size(), st.ModTime()})
				total += st.Size()
			}
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].at.Before(all[j].at) })
	for _, x := range all {
		if total <= maxTotal {
			break
		}
		os.Remove(x.file)
		os.Remove(x.file + ".json")
		total -= x.size
	}
}

var errTooLarge = errors.New("file too large")

func store(host, id string, src io.Reader, name, typ string) (int, any) {
	os.MkdirAll(filepath.Join(dir, host), 0o755)
	abs := where(host, id)
	tmp := fmt.Sprintf("%s.%d.tmp", abs, os.Getpid())
	out, err := os.Create(tmp)
	big := fmt.Sprintf("over %dMB", MaxFile/1048576)
	if err != nil {
		return 500, map[string]any{"error": err.Error()}
	}
	n, err := io.Copy(out, io.LimitReader(src, MaxFile+1))
	cerr := out.Close()
	if err == nil && n > MaxFile {
		err = errTooLarge
	}
	if err == nil {
		err = cerr
	}
	if err == nil {
		m := Meta{name, typ, n}
		if err = os.WriteFile(abs+".json", util.Marshal(m), 0o644); err == nil {
			err = os.Rename(tmp, abs)
		}
		if err == nil {
			go prune()
			return 200, map[string]any{"host": host, "id": id, "name": name, "type": typ, "size": n}
		}
	}
	os.Remove(tmp)
	if errors.Is(err, errTooLarge) {
		io.Copy(io.Discard, src)
		return 413, map[string]any{"error": big}
	}
	return 500, map[string]any{"error": err.Error()}
}

var badNameRe = regexp.MustCompile(`[/\\\x00]`)

// Save a browser's upload
func Save(host string, r *http.Request, name, typ string) (int, any) {
	if cl, err := strconv.ParseInt(r.Header.Get("Content-Length"), 10, 64); err == nil && cl > MaxFile {
		return 413, map[string]any{"error": fmt.Sprintf("over %dMB", MaxFile/1048576)}
	}
	b := make([]byte, 16)
	rand.Read(b)
	n := clip(badNameRe.ReplaceAllString(or(name, "file"), "_"), 200)
	if n == "" {
		n = "file"
	}
	t := "application/octet-stream"
	if typeRe.MatchString(typ) {
		t = strings.ToLower(typ)
	}
	return store(host, hex.EncodeToString(b), r.Body, n, t)
}

func or(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// Bundled a file shipped with the app, kept under an id from its name
func Bundled(host, name string, data []byte) map[string]any {
	h := md5.Sum([]byte(name))
	id := hex.EncodeToString(h[:])
	ext := strings.TrimPrefix(filepath.Ext(name), ".")
	info := Meta{name, "image/" + ext, int64(len(data))}
	if meta(host, id) == nil {
		os.MkdirAll(filepath.Join(dir, host), 0o755)
		os.WriteFile(where(host, id), data, 0o644)
		os.WriteFile(where(host, id)+".json", util.Marshal(info), 0o644)
	}
	return map[string]any{"host": host, "id": id, "name": info.Name, "type": info.Type, "size": info.Size}
}

// Serve one attachment, false when not held here
func Serve(w http.ResponseWriter, host, id string, download bool) bool {
	m := meta(host, id)
	if m == nil {
		return false
	}
	f, err := os.Open(where(host, id))
	if err != nil {
		return false
	}
	defer f.Close()
	in := !download && inline[m.Type]
	h := w.Header()
	ct, disp := "application/octet-stream", "attachment"
	if in {
		ct, disp = m.Type, "inline"
	}
	h.Set("Content-Type", ct)
	h.Set("Content-Length", strconv.FormatInt(m.Size, 10))
	h.Set("Content-Disposition", fmt.Sprintf("%s; filename*=UTF-8''%s", disp, EncodeURIComponent(m.Name)))
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	h.Set("X-Content-Type-Options", "nosniff")
	if m.Type != "application/pdf" {
		h.Set("Content-Security-Policy", "sandbox")
	}
	h.Set("X-Phosphorus-Media", EncodeURIComponent(string(util.Marshal(m))))
	w.WriteHeader(200)
	io.Copy(w, f)
	return true
}

// EncodeURIComponent as JS's
func EncodeURIComponent(s string) string {
	e := url.QueryEscape(s)
	e = strings.ReplaceAll(e, "+", "%20")
	for _, c := range []string{"!", "'", "(", ")", "*", "~"} {
		e = strings.ReplaceAll(e, url.QueryEscape(c), c)
	}
	return e
}

var (
	pullMu  sync.Mutex
	pulling = map[string]chan struct{}{}
	pullOK  = map[string]bool{}
)

// Pull from the host it lives on, cached here, one pull per file
func Pull(host, id, ip string, port int) bool {
	key := host + "/" + id
	pullMu.Lock()
	if ch, ok := pulling[key]; ok {
		pullMu.Unlock()
		<-ch
		pullMu.Lock()
		defer pullMu.Unlock()
		return pullOK[key]
	}
	ch := make(chan struct{})
	pulling[key] = ch
	pullMu.Unlock()
	ok := fetchOnce(host, id, ip, port)
	pullMu.Lock()
	pullOK[key] = ok
	delete(pulling, key)
	pullMu.Unlock()
	close(ch)
	return ok
}

func fetchOnce(host, id, ip string, port int) bool {
	c := &http.Client{Timeout: 60 * time.Second, Transport: &http.Transport{Proxy: nil}}
	res, err := c.Get(fmt.Sprintf("http://%s:%d/api/chat/media/%s/%s?hop=1", ip, port, host, id))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	raw, _ := url.QueryUnescape(strings.ReplaceAll(res.Header.Get("X-Phosphorus-Media"), "+", "%2B"))
	var info map[string]any
	if res.StatusCode != 200 || json.Unmarshal([]byte(raw), &info) != nil || info == nil {
		io.Copy(io.Discard, res.Body)
		return false
	}
	name := util.Str(info["name"])
	if name == "" {
		name = "file"
	}
	s, _ := store(host, id, res.Body, clip(name, 200), util.Str(info["type"]))
	return s == 200
}
