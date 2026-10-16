package web

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

// dist: go generate's build of web/, esbuild's hashed files, vendor files and
// each one's .br and .gz beside it, hashed ones kept only compressed
//
//go:embed all:dist
var distFS embed.FS

//go:generate go run ../../cmd/webbuild -src ../../web -out dist

var dist, _ = fs.Sub(distFS, "dist")

var types = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
	".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".gif": "image/gif",
	".wasm": "application/wasm", ".map": "application/json",
}

var (
	etagMu sync.Mutex
	etags  = map[string]string{}
)

func etagOf(name string, b []byte) string {
	etagMu.Lock()
	defer etagMu.Unlock()
	if e, ok := etags[name]; ok {
		return e
	}
	h := sha256.Sum256(b)
	e := `"` + hex.EncodeToString(h[:8]) + `"`
	etags[name] = e
	return e
}

// hashed: esbuild's [name]-[hash] files under assets/, cached for good
func hashed(p string) bool {
	return strings.HasPrefix(p, "assets/") || strings.HasPrefix(p, "vendor/h/")
}

func accepts(r *http.Request, enc string) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		f := strings.Split(part, ";")
		if strings.TrimSpace(f[0]) != enc {
			continue
		}
		for _, p := range f[1:] {
			if q, ok := strings.CutPrefix(strings.TrimSpace(p), "q="); ok {
				v, err := strconv.ParseFloat(q, 64)
				return err == nil && v > 0
			}
		}
		return true
	}
	return false
}

// ServeStatic the page and its files, precompressed where the browser takes it
func ServeStatic(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if p == "/" || p == "" {
		p = "/index.html"
	}
	name := strings.TrimPrefix(path.Clean(p), "/")
	if name == "" || strings.HasSuffix(name, ".br") || strings.HasSuffix(name, ".gz") {
		http.Error(w, "not found", 404)
		return
	}
	b, err := fs.ReadFile(dist, name)
	packed := false
	if err != nil {
		b, err = fs.ReadFile(dist, name+".gz")
		packed = true
	}
	if err != nil {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(404)
		w.Write([]byte("not found"))
		return
	}
	h := w.Header()
	ext := path.Ext(name)
	ct := types[ext]
	if ct == "" {
		ct = mime.TypeByExtension(ext)
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	h.Set("Content-Type", ct)
	etag := etagOf(name, b)
	h.Set("ETag", etag)
	h.Set("Vary", "Accept-Encoding")
	switch {
	case hashed(name):
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	case ext == ".woff2":
		h.Set("Cache-Control", "public, max-age=86400")
	default:
		h.Set("Cache-Control", "no-cache")
	}
	if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
		w.WriteHeader(304)
		return
	}
	var body []byte
	for _, enc := range []struct{ name, ext string }{{"br", ".br"}, {"gzip", ".gz"}} {
		if !accepts(r, enc.name) {
			continue
		}
		if c, err := fs.ReadFile(dist, name+enc.ext); err == nil {
			h.Set("Content-Encoding", enc.name)
			body = c
			break
		}
	}
	if body == nil && packed {
		body = gunzip(b)
	} else if body == nil {
		body = b
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(200)
	if r.Method != "HEAD" {
		w.Write(body)
	}
}

// gunzip a compressed-only file for a browser that takes neither encoding
func gunzip(b []byte) []byte {
	z, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil
	}
	out, _ := io.ReadAll(z)
	return out
}
