package sulfur

// Open VSX (open-vsx.org): the library Sulfur's Extensions view browses, each
// result with what it would convert to, read from its package.json alone; and
// Convert & Install, the .vsix fetched and checked against the registry's sha256
// and converted (vsx_convert.go) into the files the page writes to
// ~/.sulfur/extensions. A language server a package carries is installed apart,
// by the language host on the host it runs on (languages_host.go).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// VSXRegistry the registry's API, SULFUR_VSX_REGISTRY for another Open VSX
func VSXRegistry() string {
	if r := strings.TrimRight(os.Getenv("SULFUR_VSX_REGISTRY"), "/"); strings.HasPrefix(r, "https://") {
		return r
	}
	return "https://open-vsx.org/api"
}

var vsxClient = &http.Client{Timeout: 120 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
	if req.URL.Scheme != "https" {
		return errors.New("Open VSX redirects must use HTTPS")
	}
	if len(via) >= 10 {
		return errors.New("too many Open VSX redirects")
	}
	return nil
}}

func vsxGet(ctx context.Context, u string, limit int64) ([]byte, error) {
	if !strings.HasPrefix(u, "https://") {
		return nil, errors.New("Open VSX is reached over HTTPS only")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Sulfur-extensions")
	req.Header.Set("Accept", "application/json, */*")
	r, err := vsxClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode < 200 || r.StatusCode >= 300 {
		return nil, fmt.Errorf("%s answered %s", r.Request.URL.Host, r.Status)
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("over %dMB", limit>>20)
	}
	return b, nil
}

// registryURL a path under the registry, each part escaped
func registryURL(parts ...string) string {
	u := VSXRegistry()
	for _, p := range parts {
		u += "/" + url.PathEscape(p)
	}
	return u
}

// --- the library ----------------------------------------------------------------------

// VSXEntry one extension as the library lists it
type VSXEntry struct {
	Namespace     string          `json:"namespace"`
	Name          string          `json:"name"`
	Version       string          `json:"version"`
	DisplayName   string          `json:"displayName"`
	Description   string          `json:"description"`
	DownloadCount int64           `json:"downloadCount"`
	Rating        float64         `json:"averageRating,omitempty"`
	Icon          string          `json:"icon,omitempty"`
	Timestamp     string          `json:"timestamp,omitempty"`
	Verified      bool            `json:"verified"`
	Deprecated    bool            `json:"deprecated,omitempty"`
	Categories    []string        `json:"categories,omitempty"`
	Plan          []VSXReportItem `json:"plan"`
	PlanError     string          `json:"planError,omitempty"`
	Manifest      map[string]any  `json:"manifest,omitempty"`
}

// VSXPage a page of the library
type VSXPage struct {
	Offset     int        `json:"offset"`
	TotalSize  int        `json:"totalSize"`
	Extensions []VSXEntry `json:"extensions"`
}

// manifests read for plans, kept: a version's package.json never changes
var (
	planMu    sync.Mutex
	planCache = map[string]*vsxManifestEntry{}
	planOrder []string
	planBytes int
)

type vsxManifestEntry struct {
	done chan struct{}
	m    map[string]any
	err  error
	size int
}

// Only handler identities travel with search results, not schemas or asset data.
func vsxPreview(m map[string]any) map[string]any {
	c := asMap(m["contributes"])
	out := map[string]any{}
	for _, key := range []string{"keybindings", "languages"} {
		if c[key] != nil {
			out[key] = c[key]
		}
	}
	var editors, views []any
	web := str(m["browser"]) != ""
	if web {
		out["commands"] = c["commands"]
	}
	for _, value := range asList(c["customEditors"]) {
		if !web {
			break
		}
		e := asMap(value)
		var patterns []string
		for _, selector := range asList(e["selector"]) {
			patterns = append(patterns, str(asMap(selector)["filenamePattern"]))
		}
		editors = append(editors, map[string]any{"viewType": e["viewType"], "filenamePatterns": patterns, "priority": e["priority"]})
	}
	for _, group := range asMap(c["views"]) {
		if !web {
			break
		}
		for _, value := range asList(group) {
			views = append(views, map[string]any{"id": asMap(value)["id"]})
		}
	}
	out["customEditors"], out["views"] = editors, views
	return map[string]any{"contributes": out, "extensionDependencies": m["extensionDependencies"]}
}

// vsxManifest a version's package.json: beside its download, which names a platform-specific
// package's target (.../linux-x64/1.0.0/file/x.vsix), else at the version's own path
func vsxManifest(ctx context.Context, ns, name, version, download string) (map[string]any, error) {
	u := registryURL(ns, name, version, "file", "package.json")
	if i := strings.LastIndex(download, "/file/"); i > 0 && strings.HasPrefix(download, VSXRegistry()+"/") {
		u = download[:i] + "/file/package.json"
	}
	key := u
	planMu.Lock()
	if entry := planCache[key]; entry != nil {
		planMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-entry.done:
			if entry.err != nil && ctx.Err() == nil && (errors.Is(entry.err, context.Canceled) || errors.Is(entry.err, context.DeadlineExceeded)) {
				return vsxManifest(ctx, ns, name, version, download)
			}
			return entry.m, entry.err
		}
	}
	entry := &vsxManifestEntry{done: make(chan struct{})}
	planCache[key] = entry
	planMu.Unlock()
	var m map[string]any
	defer func() {
		planMu.Lock()
		entry.m = m
		if entry.err != nil {
			delete(planCache, key)
		} else {
			planOrder = append(planOrder, key)
			planBytes += entry.size
			for len(planOrder) > 512 || planBytes > 16<<20 {
				if old := planCache[planOrder[0]]; old != nil {
					planBytes -= old.size
				}
				delete(planCache, planOrder[0])
				planOrder = planOrder[1:]
			}
		}
		close(entry.done)
		planMu.Unlock()
	}()
	b, err := vsxGet(ctx, u, 4<<20)
	if err != nil {
		entry.err = err
		return nil, err
	}
	entry.size = len(b)
	if err := json.Unmarshal(stripJSONC(b), &m); err != nil || m == nil {
		entry.err = errors.New("its package.json isn't JSON")
		return nil, entry.err
	}
	return m, nil
}

var vsxSorts = map[string]string{"relevance": "relevance", "downloads": "downloadCount", "rating": "averageRating", "updated": "timestamp"}

// VSXSearch a page of the library, each extension's plan read from its manifest
func VSXSearch(ctx context.Context, query, category, sort string, offset, size int) (*VSXPage, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	if size <= 0 || size > 50 {
		size = 20
	}
	if offset < 0 {
		offset = 0
	}
	q := url.Values{"query": {query}, "offset": {strconv.Itoa(offset)}, "size": {strconv.Itoa(size)}, "includeAllVersions": {"false"}}
	if s := vsxSorts[sort]; s != "" {
		q.Set("sortBy", s)
		q.Set("sortOrder", "desc")
	} else if query == "" {
		q.Set("sortBy", "downloadCount")
		q.Set("sortOrder", "desc")
	}
	if category != "" {
		q.Set("category", category)
	}
	b, err := vsxGet(ctx, VSXRegistry()+"/-/search?"+q.Encode(), 8<<20)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Offset     int `json:"offset"`
		TotalSize  int `json:"totalSize"`
		Extensions []struct {
			VSXEntry
			Files map[string]string `json:"files"`
		} `json:"extensions"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, errors.New("Open VSX's search answered something else: " + err.Error())
	}
	page := &VSXPage{Offset: raw.Offset, TotalSize: raw.TotalSize, Extensions: make([]VSXEntry, len(raw.Extensions))}
	planCtx, cancelPlans := context.WithTimeout(ctx, 8*time.Second)
	defer cancelPlans()
	var wg sync.WaitGroup
	gate := make(chan struct{}, 8)
	for i, e := range raw.Extensions {
		entry := e.VSXEntry
		entry.Icon = e.Files["icon"]
		page.Extensions[i] = entry
		download := e.Files["download"]
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			select {
			case gate <- struct{}{}:
			case <-planCtx.Done():
				page.Extensions[i].PlanError = planCtx.Err().Error()
				return
			}
			defer func() { <-gate }()
			x := &page.Extensions[i]
			c, cancel := context.WithTimeout(planCtx, 6*time.Second)
			defer cancel()
			m, err := vsxManifest(c, x.Namespace, x.Name, x.Version, download)
			if err != nil {
				x.PlanError, x.Plan = err.Error(), []VSXReportItem{}
				return
			}
			x.Plan = VSXPlan(m)
			x.Manifest = vsxPreview(m)
			for _, c := range asList(m["categories"]) {
				x.Categories = append(x.Categories, str(c))
			}
		}(i)
	}
	wg.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return page, nil
}

// --- converting one --------------------------------------------------------------------

// vsxMeta a version's registry record
type vsxMeta struct {
	Namespace      string            `json:"namespace"`
	Name           string            `json:"name"`
	Version        string            `json:"version"`
	TargetPlatform string            `json:"targetPlatform"`
	Files          map[string]string `json:"files"`
	Downloads      map[string]string `json:"downloads"`
	Error          string            `json:"error"`
}

// vsxPlatform this computer as Open VSX names targets: win32-x64, linux-arm64, darwin-arm64, ...
func vsxPlatform() string {
	osName := map[string]string{"windows": "win32", "darwin": "darwin"}[runtime.GOOS]
	if osName == "" {
		osName = "linux"
	}
	arch := map[string]string{"amd64": "x64", "arm64": "arm64", "arm": "armhf"}[runtime.GOARCH]
	return osName + "-" + arch
}

// pickDownload never installs an arbitrary foreign platform's executable.
func pickDownload(downloads map[string]string, fallback string) (string, string) {
	for _, p := range []string{vsxPlatform(), "universal"} {
		if u := downloads[p]; u != "" {
			return p, u
		}
	}
	if len(downloads) > 0 {
		return "", ""
	}
	return "", fallback
}

// fetchVSIX a version's package, checked against the registry's sha256
func fetchVSIX(ctx context.Context, download string) ([]byte, string, error) {
	if !strings.HasPrefix(download, VSXRegistry()+"/") {
		return nil, "", errors.New("a package is fetched from " + VSXRegistry() + " only")
	}
	data, err := vsxGet(ctx, download, 512<<20)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	u, err := url.Parse(download)
	if err != nil || !strings.HasSuffix(u.Path, ".vsix") {
		return nil, "", errors.New("the registry package has no .vsix checksum location")
	}
	u.Path = strings.TrimSuffix(u.Path, ".vsix") + ".sha256"
	b, err := vsxGet(ctx, u.String(), 4096)
	if err != nil {
		return nil, "", fmt.Errorf("cannot verify the registry's sha256: %w", err)
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 || len(fields[0]) != 64 || strings.ToLower(fields[0]) != got {
		return nil, "", errors.New("the package doesn't match the registry's sha256")
	}
	return data, got, nil
}

// VSXConvert a version (the latest when version is "") fetched and converted
func VSXConvert(ctx context.Context, ns, name, version string, opt VSXOptions) (*VSXConversion, error) {
	parts := []string{ns, name}
	if version != "" {
		parts = append(parts, version)
	}
	b, err := vsxGet(ctx, registryURL(parts...), 8<<20)
	if err != nil {
		return nil, err
	}
	var meta vsxMeta
	if err := json.Unmarshal(b, &meta); err != nil || meta.Error != "" {
		if meta.Error != "" {
			return nil, errors.New(meta.Error)
		}
		return nil, errors.New("Open VSX answered something else")
	}
	platform, download := pickDownload(meta.Downloads, meta.Files["download"])
	if download == "" && meta.Downloads["web"] != "" {
		platform, download = "web", meta.Downloads["web"]
	}
	if platform == "" {
		platform = meta.TargetPlatform
	}
	if platform != "" && platform != "universal" && platform != "web" && platform != vsxPlatform() {
		return nil, fmt.Errorf("no package for %s (the registry offered %s)", vsxPlatform(), platform)
	}
	if download == "" {
		return nil, errors.New(ns + "." + name + " has nothing to download")
	}
	data, sum, err := fetchVSIX(ctx, download)
	if err != nil {
		return nil, err
	}
	src := VSXSource{Registry: VSXRegistry(), Namespace: meta.Namespace, Name: meta.Name, Version: meta.Version, TargetPlatform: platform, Download: download, SHA256: sum}
	conv, err := ConvertVSIX(data, src, opt)
	if err != nil {
		return nil, err
	}
	// a server's package fetched again by each host, for its own platform
	if servers, ok := conv.Manifest["contributes"].(map[string]any)["languageServers"].([]any); ok {
		downloads := meta.Downloads
		if len(downloads) == 0 {
			downloads = map[string]string{platform: download}
		}
		for _, s := range servers {
			s.(map[string]any)["downloads"] = downloads
		}
		conv.Files["package.json"] = jsonText(conv.Manifest)
	}
	return conv, nil
}

// --- the page's calls ----------------------------------------------------------------------

var vsxNameRe = regexp.MustCompile(`^[\w.-]{1,128}$`)

// VSXServe /api/sulfur/vsx/search (GET q, category, sort, offset, size) and
// /api/sulfur/vsx/convert (POST {namespace, name, version, commands})
func VSXServe(w http.ResponseWriter, r *http.Request) {
	send := func(code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		enc.Encode(v)
	}
	fail := func(code int, err error) { send(code, map[string]any{"error": err.Error()}) }
	switch {
	case strings.HasSuffix(r.URL.Path, "/vsx/search") && r.Method == "GET":
		q := r.URL.Query()
		offset, _ := strconv.Atoi(q.Get("offset"))
		size, _ := strconv.Atoi(q.Get("size"))
		page, err := VSXSearch(r.Context(), q.Get("q"), q.Get("category"), q.Get("sort"), offset, size)
		if err != nil {
			fail(502, err)
			return
		}
		send(200, page)
	case strings.HasSuffix(r.URL.Path, "/vsx/convert") && r.Method == "POST":
		var p struct {
			Namespace string   `json:"namespace"`
			Name      string   `json:"name"`
			Version   string   `json:"version"`
			Commands  []string `json:"commands"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&p) != nil || !vsxNameRe.MatchString(p.Namespace) || !vsxNameRe.MatchString(p.Name) || (p.Version != "" && !vsxNameRe.MatchString(p.Version)) {
			fail(400, errors.New("a namespace, name and version"))
			return
		}
		opt := VSXOptions{Commands: map[string]bool{}}
		for _, c := range p.Commands {
			opt.Commands[c] = true
		}
		conv, err := VSXConvert(r.Context(), p.Namespace, p.Name, p.Version, opt)
		if err != nil {
			fail(502, err)
			return
		}
		send(200, conv)
	default:
		fail(404, errors.New("no such call"))
	}
}
