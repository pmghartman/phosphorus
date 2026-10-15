// Package files: each [files] dir mounted under SHARE_ROOT, every request
// path held inside its share and every write checked against its perms
package files

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	ShareRoot = util.Env("SHARE_ROOT", "/shares")
	FilesRoot = util.Env("FILES_ROOT", "/files")
	StateDir  = util.Env("STATE_DIR", "/state")
	HomeFS    = util.Env("HOME_FS", StateDir)
	HomeRoot  = filepath.Join(HomeFS, Home)
)

const (
	MaxPreview   = 512 * 1024
	MaxUpload    = 256 * 1024 * 1024
	maxEntries   = 5000
	treeDepthMax = 8
	treeMax      = 2000
	uploadTmp    = ".phosphorus-upload-"
	fullPerms    = "rwd"
	Home         = "home"
	Desktop      = "Desktop"
	Shared       = "shared"
	Sys          = "sys"
	statWidth    = 64
)

// E an error body, {error}
type E = map[string]any

func errBody(msg string) E { return E{"error": msg} }

// Share one served folder
type Share struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Perms string `json:"perms"`
	Root  string `json:"-"`
	Real  string `json:"-"`
	OK    bool   `json:"-"`
	Home  bool   `json:"home,omitempty"`
}

func cleanPerms(spec string) string {
	want := strings.ToLower(spec)
	out := ""
	for _, c := range []string{"r", "w", "d"} {
		if strings.Contains(want, c) {
			out += c
		}
	}
	return out
}

func splitList(v string) []string {
	out := []string{}
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// ConfiguredDirs [files] dir as phosphorus.ini says now
func ConfiguredDirs() []string { return splitList(util.Ini("files", "dir")) }

func mountedDirs() []string { return splitList(os.Getenv("PHOSPHORUS_FILES_DIRS")) }

var (
	mountsMu   sync.RWMutex
	hostMounts = map[string]string{}
)

func loadMounts() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "inspect", "phosphorus", "--format", "{{range .Mounts}}{{.Destination}}\t{{.Source}}\n{{end}}").Output()
	if err != nil {
		time.AfterFunc(60*time.Second, loadMounts)
		return
	}
	mountsMu.Lock()
	defer mountsMu.Unlock()
	for _, line := range strings.Split(string(out), "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
			hostMounts[strings.TrimRight(parts[0], "/")] = parts[1]
		}
	}
}

var vmRe = regexp.MustCompile(`^/run/desktop/mnt/host/([a-z])(/.*)?$`)
var trailRe = regexp.MustCompile(`(.)/+$`)

// HostSpelling Docker Desktop's VM spelling back to the Windows drive
func HostSpelling(src string) string {
	p := src
	if m := vmRe.FindStringSubmatch(src); m != nil {
		rest := m[2]
		if rest == "" {
			rest = "/"
		}
		p = strings.ToUpper(m[1]) + ":" + rest
	}
	p = strings.ReplaceAll(p, `\`, "/")
	return trailRe.ReplaceAllString(p, "$1")
}

// HostPathOf a container path as it lives on the host
func HostPathOf(p string) string {
	mountsMu.RLock()
	defer mountsMu.RUnlock()
	for at := p; at != "" && at != "/"; at = path.Dir(at) {
		if src, ok := hostMounts[at]; ok {
			return HostSpelling(src) + p[len(at):]
		}
	}
	return ""
}

var absRe = regexp.MustCompile(`^([A-Za-z]:)?/`)
var repoRe = regexp.MustCompile(`^/repo(/|$)`)

func labelFor(dir, root string) string {
	if h := HostPathOf(root); h != "" {
		return h
	}
	clean := trailRe.ReplaceAllString(strings.ReplaceAll(dir, `\`, "/"), "$1")
	if absRe.MatchString(clean) && !repoRe.MatchString(clean) {
		return clean
	}
	return root
}

func makeShare(id, dir, perms, root string) Share {
	real := root
	if r, err := filepath.EvalSymlinks(root); err == nil {
		real = r
	}
	ok := false
	if st, err := os.Stat(root); err == nil && st.IsDir() {
		ok = true
	}
	return Share{ID: id, Label: labelFor(dir, root), Perms: perms, Root: root, Real: real, OK: ok}
}

func buildShares() []Share {
	dirs := mountedDirs()
	if len(dirs) == 0 {
		return []Share{makeShare("0", os.Getenv("PHOSPHORUS_FILES_DIR"), fullPerms, FilesRoot)}
	}
	perms := splitList(os.Getenv("PHOSPHORUS_FILES_PERMS"))
	out := []Share{}
	for i, d := range dirs {
		p := fullPerms
		if i < len(perms) {
			p = cleanPerms(perms[i])
		}
		out = append(out, makeShare(strconv.Itoa(i), d, p, filepath.Join(ShareRoot, strconv.Itoa(i))))
	}
	return out
}

func move(from, to string) {
	if !exists(from) || exists(to) {
		return
	}
	if err := os.Rename(from, to); err != nil {
		log.Printf("[files] moving %s into the home: %v", from, err)
	}
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func flatten(from string) {
	st, err := os.Stat(filepath.Join(from, Shared))
	if err != nil || !st.IsDir() {
		return
	}
	ents, err := os.ReadDir(from)
	if err != nil {
		return
	}
	for _, e := range ents {
		if e.Name() != Sys {
			move(filepath.Join(from, e.Name()), filepath.Join(HomeRoot, e.Name()))
		}
	}
	os.Remove(from)
}

func lift() {
	if !exists(filepath.Join(HomeFS, Sys)) || exists(filepath.Join(HomeRoot, Sys)) {
		return
	}
	users := []string{}
	if ents, err := os.ReadDir(filepath.Join(HomeFS, Sys, "etc", "passwd")); err == nil {
		for _, e := range ents {
			if strings.HasSuffix(e.Name(), ".json") {
				users = append(users, strings.TrimSuffix(e.Name(), ".json"))
			}
		}
	}
	for _, n := range append([]string{Sys, Shared}, users...) {
		move(filepath.Join(HomeFS, n), filepath.Join(HomeRoot, n))
	}
}

var initOnce sync.Once

// Init the home's layout moved into place, mounts looked up
func Init() {
	initOnce.Do(func() {
		os.MkdirAll(HomeRoot, 0o755)
		lift()
		flatten(filepath.Join(HomeFS, "usr"))
		a, _ := filepath.Abs(StateDir)
		b, _ := filepath.Abs(HomeFS)
		if a != b {
			flatten(filepath.Join(StateDir, "home"))
		}
		os.MkdirAll(filepath.Join(HomeRoot, Shared, Desktop), 0o755)
		go loadMounts()
	})
}

// HomeDir where the home lives on the host now
func HomeDir() string {
	if h := HostPathOf(HomeRoot); h != "" {
		return h
	}
	if d := os.Getenv("PHOSPHORUS_HOME_DIR"); d != "" {
		return strings.TrimRight(d, `\/`) + "/" + Home
	}
	return HomeRoot
}

func homeShare() Share {
	s := makeShare("home", "", fullPerms, HomeRoot)
	s.Label = HomeDir()
	s.Home = true
	return s
}

var (
	homeIDMu sync.Mutex
	homeID   string
)

func idOf(p string) string {
	st, err := os.Stat(p)
	if err != nil {
		return ""
	}
	s := st.Sys().(*syscall.Stat_t)
	return fmt.Sprintf("%d:%d", s.Dev, s.Ino)
}

func isHome(p string) bool {
	homeIDMu.Lock()
	if homeID == "" {
		homeID = idOf(HomeRoot)
	}
	h := homeID
	homeIDMu.Unlock()
	return h != "" && idOf(p) == h
}

func homeHeld(sh Share, p string) bool {
	if sh.ID == "home" {
		return false
	}
	for at := p; ; at = filepath.Dir(at) {
		if isHome(at) {
			return true
		}
		if at == sh.Real || at == filepath.Dir(at) {
			return false
		}
	}
}

// Shares every share up now, the home first
func Shares() []Share {
	out := []Share{}
	for _, s := range append([]Share{homeShare()}, buildShares()...) {
		if s.OK {
			out = append(out, s)
		}
	}
	return out
}

// ShareOf by id, nil when none
func ShareOf(id string) *Share {
	for _, s := range Shares() {
		if s.ID == id {
			s := s
			return &s
		}
	}
	return nil
}

// Can a share's perm
func Can(sh *Share, perm string) bool { return sh != nil && strings.Contains(sh.Perms, perm) }

// Enabled any share up
func Enabled() bool { return len(Shares()) > 0 }

func inside(sh Share, p string) bool {
	return p == sh.Real || strings.HasPrefix(p, sh.Real+string(filepath.Separator))
}

func toAbs(sh Share, rel string) string {
	clean := strings.ReplaceAll(rel, `\`, "/")
	if strings.Contains(clean, "\x00") {
		return ""
	}
	abs := filepath.Join(sh.Real, "./"+strings.TrimLeft(clean, "/"))
	if !inside(sh, abs) {
		return ""
	}
	return abs
}

// SafePath the resolved target held to the share, a new file's parent
func SafePath(sh Share, rel string, mustExist bool) string {
	abs := toAbs(sh, rel)
	if abs == "" {
		return ""
	}
	at := abs
	if !mustExist {
		at = filepath.Dir(abs)
	}
	real, err := filepath.EvalSymlinks(at)
	if err != nil {
		return ""
	}
	if inside(sh, real) && !homeHeld(sh, real) {
		return abs
	}
	return ""
}

// RelOf an absolute path off the share's root
func RelOf(sh Share, abs string) string {
	r, err := filepath.Rel(sh.Real, abs)
	if err != nil || r == "." {
		return ""
	}
	return filepath.ToSlash(r)
}

// Located a path back to its share
type Located struct {
	Share string
	Path  string
}

// Locate an absolute path back to its share, nil outside them all
func Locate(abs string) *Located {
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil
	}
	for _, s := range Shares() {
		if s.ID != "home" && inside(s, real) && !homeHeld(s, real) {
			return &Located{s.ID, RelOf(s, real)}
		}
	}
	return nil
}

// Entry one listed name
type Entry struct {
	Name  string `json:"name"`
	Dir   bool   `json:"dir"`
	Empty *bool  `json:"empty,omitempty"`
	Link  bool   `json:"link"`
	Size  *int64 `json:"size"`
	Mtime *int64 `json:"mtime"`
	All   bool   `json:"all,omitempty"`
}

func mtimeMS(t time.Time) int64 { return int64(math.Round(float64(t.UnixNano()) / 1e6)) }

func isEmptyDir(abs string) *bool {
	f, err := os.Open(abs)
	if err != nil {
		return nil
	}
	defer f.Close()
	_, err = f.Readdirnames(1)
	b := errors.Is(err, io.EOF)
	if err != nil && !b {
		return nil
	}
	return &b
}

func entryOf(dir, name string) *Entry {
	abs := filepath.Join(dir, name)
	lst, err := os.Lstat(abs)
	if err != nil {
		return nil
	}
	link := lst.Mode()&os.ModeSymlink != 0
	var target os.FileInfo = lst
	if link {
		if t, err := os.Stat(abs); err == nil {
			target = t
		} else {
			target = nil
		}
	}
	e := &Entry{Name: name, Link: link}
	e.Dir = target != nil && target.IsDir()
	if e.Dir && !link {
		e.Empty = isEmptyDir(abs)
	}
	if target != nil && target.Mode().IsRegular() {
		s := target.Size()
		e.Size = &s
	}
	if target != nil {
		m := mtimeMS(target.ModTime())
		e.Mtime = &m
	}
	return e
}

func entriesOf(dir string, names []string) []Entry {
	out := make([]*Entry, len(names))
	var wg sync.WaitGroup
	sem := make(chan struct{}, statWidth)
	for i, n := range names {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, n string) {
			defer wg.Done()
			out[i] = entryOf(dir, n)
			<-sem
		}(i, n)
	}
	wg.Wait()
	res := []Entry{}
	for _, e := range out {
		if e != nil {
			res = append(res, *e)
		}
	}
	return res
}

// List a folder's entries, folders first
func List(sh *Share, rel string) (int, any) {
	if !Can(sh, "r") {
		return 403, errBody("this share is not readable")
	}
	abs := SafePath(*sh, rel, true)
	if abs == "" {
		return 400, errBody("bad path")
	}
	f, err := os.Open(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 404, errBody("no such directory")
		}
		return 500, errBody(err.Error())
	}
	names, err := f.Readdirnames(-1)
	f.Close()
	if err != nil {
		if errors.Is(err, syscall.ENOTDIR) || strings.Contains(err.Error(), "not a directory") {
			return 400, errBody("not a directory")
		}
		return 500, errBody(err.Error())
	}
	kept := []string{}
	for _, n := range names {
		if strings.HasPrefix(n, uploadTmp) {
			continue
		}
		if sh.ID != "home" && isHome(filepath.Join(abs, n)) {
			continue
		}
		kept = append(kept, n)
	}
	cut := kept
	if len(cut) > maxEntries {
		cut = cut[:maxEntries]
	}
	entries := entriesOf(abs, cut)
	sort.SliceStable(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		if a.Dir == b.Dir {
			return util.LocaleCompare(a.Name, b.Name) < 0
		}
		return a.Dir
	})
	return 200, map[string]any{"path": RelOf(*sh, abs), "truncated": len(kept) > maxEntries, "entries": entries}
}

func globRe(g string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("(?i)^")
	for _, r := range g {
		switch r {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	b.WriteString("$")
	re, err := regexp.Compile(b.String())
	if err != nil {
		return regexp.MustCompile(`^$`)
	}
	return re
}

// TreeEntry a tree's row, folders as "path/"
type TreeEntry struct {
	Path  string `json:"path"`
	Size  *int64 `json:"size,omitempty"`
	Mtime *int64 `json:"mtime"`
}

// Tree every entry under rel to depth, breadth first
func Tree(sh *Share, rel string, depth any, match string) (int, any) {
	if !Can(sh, "r") {
		return 403, errBody("this share is not readable")
	}
	root := SafePath(*sh, rel, true)
	if root == "" {
		return 400, errBody("bad path")
	}
	st, err := os.Stat(root)
	if err != nil {
		return 404, errBody("no such directory")
	}
	if !st.IsDir() {
		return 400, errBody("not a directory")
	}
	var want *regexp.Regexp
	if match != "" {
		want = globRe(match)
	}
	d := int(JSNumber(depth))
	if d < 1 {
		d = 1
	}
	maxDepth := d
	if maxDepth > treeDepthMax {
		maxDepth = treeDepthMax
	}
	out := []map[string]any{}
	truncated := false
	level := []string{root}
	for lv := 1; lv <= maxDepth && len(level) > 0 && !truncated; lv++ {
		next := []string{}
		for _, dir := range level {
			f, err := os.Open(dir)
			if err != nil {
				continue
			}
			ns, err := f.Readdirnames(-1)
			f.Close()
			if err != nil {
				continue
			}
			names := []string{}
			for _, n := range ns {
				if !strings.HasPrefix(n, uploadTmp) && (sh.ID == "home" || !isHome(filepath.Join(dir, n))) {
					names = append(names, n)
				}
			}
			sort.SliceStable(names, func(i, j int) bool { return util.LocaleCompare(names[i], names[j]) < 0 })
			for _, e := range entriesOf(dir, names) {
				rp := RelOf(*sh, filepath.Join(dir, e.Name))
				if e.Dir && !e.Link {
					next = append(next, filepath.Join(dir, e.Name))
				}
				if want != nil && !want.MatchString(e.Name) {
					continue
				}
				if len(out) >= treeMax {
					truncated = true
					break
				}
				if e.Dir {
					out = append(out, map[string]any{"path": rp + "/", "mtime": e.Mtime})
				} else {
					out = append(out, map[string]any{"path": rp, "size": e.Size, "mtime": e.Mtime})
				}
			}
			if truncated {
				break
			}
		}
		level = next
	}
	res := map[string]any{"path": RelOf(*sh, root), "depth": maxDepth, "entries": out}
	if truncated {
		res["truncated"] = true
	}
	return 200, res
}

// JSNumber as JS Number(v): strings parsed, null/"" 0, else NaN
func JSNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0
		}
		if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
			if n, err := strconv.ParseInt(s[2:], 16, 64); err == nil {
				return float64(n)
			}
			return math.NaN()
		}
		if s == "Infinity" || s == "+Infinity" {
			return math.Inf(1)
		}
		if s == "-Infinity" {
			return math.Inf(-1)
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil || strings.ContainsAny(s, "_") || strings.EqualFold(s, "nan") || strings.Contains(strings.ToLower(s), "inf") {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

// MakeParents a destination's missing folders made, held to the share
func MakeParents(sh Share, rel string) {
	abs := toAbs(sh, rel)
	if abs == "" {
		return
	}
	dir := filepath.Dir(abs)
	for !exists(dir) {
		dir = filepath.Dir(dir)
	}
	if real, err := filepath.EvalSymlinks(dir); err == nil && inside(sh, real) {
		os.MkdirAll(filepath.Dir(abs), 0o755)
	}
}

func looksBinary(b []byte) bool {
	n := len(b)
	if n > 8000 {
		n = 8000
	}
	for i := 0; i < n; i++ {
		if b[i] == 0 {
			return true
		}
	}
	return false
}

// Read a file as text, too big or binary marked
func Read(sh *Share, rel string) (int, any) {
	if !Can(sh, "r") {
		return 403, errBody("this share is not readable")
	}
	abs := SafePath(*sh, rel, true)
	if abs == "" {
		if SafePath(*sh, rel, false) != "" {
			return 404, errBody("no such file")
		}
		return 400, errBody("bad path")
	}
	st, err := os.Stat(abs)
	if err != nil {
		return 404, errBody("no such file")
	}
	if st.IsDir() {
		return 400, errBody("that is a directory")
	}
	p := RelOf(*sh, abs)
	if st.Size() > MaxPreview {
		return 200, map[string]any{"path": p, "size": st.Size(), "tooBig": true}
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return 500, errBody(err.Error())
	}
	if looksBinary(b) {
		return 200, map[string]any{"path": p, "size": st.Size(), "binary": true}
	}
	return 200, map[string]any{"path": p, "size": st.Size(), "text": util.UTF8(b)}
}

// DownloadPath resolved for streaming, "" when not a readable file
func DownloadPath(sh *Share, rel string) string {
	if !Can(sh, "r") {
		return ""
	}
	abs := SafePath(*sh, rel, true)
	if abs == "" {
		return ""
	}
	st, err := os.Stat(abs)
	if err != nil || !st.Mode().IsRegular() {
		return ""
	}
	return abs
}

// Stat an existing path's kind and rel, nil otherwise
type StatOut struct {
	Dir bool
	Rel string
}

// Stat an existing path
func Stat(sh *Share, rel string) *StatOut {
	if !Can(sh, "r") {
		return nil
	}
	abs := SafePath(*sh, rel, true)
	if abs == "" {
		return nil
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil
	}
	return &StatOut{st.IsDir(), RelOf(*sh, abs)}
}

// OnChange a home change told to whoever watches (the mirror)
var OnChange func(op, rel, to string)

func changed(sh Share, op, rel, to string) {
	if sh.ID == "home" && OnChange != nil {
		OnChange(op, rel, to)
	}
}

var badName = regexp.MustCompile(`[/\\]|^\.\.?$|\x00`)

// UploadQ an upload chunk's query
type UploadQ struct {
	ID     string
	Offset any
	Total  any
}

var idRe = regexp.MustCompile(`^[a-z0-9]{8,40}$`)

func isInt(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) && f == math.Trunc(f) }

// Write one chunk of an upload appended at its offset, renamed into place
// once the last lands
func Write(sh *Share, rel string, body io.Reader, q UploadQ) (int, any) {
	drain := func() { io.Copy(io.Discard, body) }
	if !Can(sh, "w") {
		return 403, errBody("this share is read-only")
	}
	MakeParents(*sh, rel)
	abs := SafePath(*sh, rel, false)
	if abs == "" || badName.MatchString(filepath.Base(abs)) {
		return 400, errBody("bad path")
	}
	total := JSNumber(q.Total)
	offset := JSNumber(q.Offset)
	if !idRe.MatchString(q.ID) || !isInt(total) || !isInt(offset) || offset < 0 || offset > total {
		drain()
		return 400, errBody("bad chunk")
	}
	if total > MaxUpload {
		drain()
		return 413, errBody("file too large")
	}
	tmp := filepath.Join(filepath.Dir(abs), uploadTmp+q.ID)
	var have int64
	if st, err := os.Stat(tmp); err == nil {
		have = st.Size()
	}
	off := int64(offset)
	tot := int64(total)
	if off > have {
		drain()
		return 409, map[string]any{"error": "chunk out of order", "have": have}
	}
	flags := os.O_WRONLY | os.O_CREATE
	if off == 0 {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(tmp, flags, 0o644)
	if err != nil {
		drain()
		return 500, errBody(err.Error())
	}
	fail := func(e error) (int, any) {
		f.Close()
		if off == 0 {
			os.Remove(tmp)
		}
		return 500, errBody(e.Error())
	}
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return fail(err)
	}
	n, err := io.Copy(f, io.LimitReader(body, tot-off+1))
	if err == nil && off+n > tot {
		drain()
		err = errors.New("chunk past the end")
	}
	if err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		return fail(err)
	}
	if off+n < tot {
		return 200, map[string]any{"ok": true, "next": off + n}
	}
	if err := os.Truncate(tmp, tot); err != nil {
		return 500, errBody(err.Error())
	}
	if err := os.Rename(tmp, abs); err != nil {
		return 500, errBody(err.Error())
	}
	changed(*sh, "write", RelOf(*sh, abs), "")
	return 200, map[string]any{"ok": true, "path": RelOf(*sh, abs)}
}

// SaveP a save's body
type SaveP struct {
	Text *string
	Old  *string
	New  *string
}

// Save a text file whole, or one exact passage in it replaced
func Save(sh *Share, rel string, p SaveP) (int, any) {
	if !Can(sh, "w") {
		return 403, errBody("this share is read-only")
	}
	MakeParents(*sh, rel)
	abs := SafePath(*sh, rel, false)
	if abs == "" || badName.MatchString(filepath.Base(abs)) {
		return 400, errBody("bad path")
	}
	var text *string = p.Text
	if p.Old != nil && p.New != nil {
		if !Can(sh, "r") {
			return 403, errBody("this share is not readable")
		}
		status, cur := Read(sh, rel)
		if status != 200 {
			return status, cur
		}
		c := cur.(map[string]any)
		t, ok := c["text"].(string)
		if !ok {
			return 400, errBody("not a text file under 512KB")
		}
		at := -1
		if *p.Old != "" {
			at = strings.Index(t, *p.Old)
		}
		if at < 0 {
			return 409, errBody("old text not found")
		}
		if strings.Contains(t[at+1:], *p.Old) {
			return 409, errBody("old text found more than once, give more of it")
		}
		s := t[:at] + *p.New + t[at+len(*p.Old):]
		text = &s
	}
	if text == nil {
		return 400, errBody("text, or old and new")
	}
	if len(*text) > MaxPreview {
		return 413, errBody("over 512KB")
	}
	made := !exists(abs)
	tmp := filepath.Join(filepath.Dir(abs), fmt.Sprintf("%s%d-%d", uploadTmp, os.Getpid(), util.Now()))
	if err := os.WriteFile(tmp, []byte(*text), 0o644); err != nil {
		os.Remove(tmp)
		return 500, errBody(err.Error())
	}
	if err := os.Rename(tmp, abs); err != nil {
		os.Remove(tmp)
		return 500, errBody(err.Error())
	}
	changed(*sh, "write", RelOf(*sh, abs), "")
	out := map[string]any{"ok": true, "path": RelOf(*sh, abs), "size": len(*text)}
	if made {
		out["created"] = true
	}
	return 200, out
}

// Mkdir a folder
func Mkdir(sh *Share, rel string) (int, any) {
	if !Can(sh, "w") {
		return 403, errBody("this share is read-only")
	}
	abs := SafePath(*sh, rel, false)
	if abs == "" || badName.MatchString(filepath.Base(abs)) {
		return 400, errBody("bad path")
	}
	if exists(abs) {
		return 409, errBody("already exists")
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return 500, errBody(err.Error())
	}
	return 200, map[string]any{"ok": true, "path": RelOf(*sh, abs)}
}

// Rename to ending in / moves into that folder under its own name
func Rename(sh *Share, from, to string) (int, any) {
	if !Can(sh, "w") {
		return 403, errBody("this share is read-only")
	}
	src := SafePath(*sh, from, true)
	if src != "" && (strings.HasSuffix(to, "/") || strings.HasSuffix(to, `\`)) {
		to = to + filepath.Base(src)
	}
	if src != "" {
		MakeParents(*sh, to)
	}
	dst := SafePath(*sh, to, false)
	if src == "" || dst == "" || badName.MatchString(filepath.Base(dst)) {
		return 400, errBody("bad path")
	}
	if src == sh.Real {
		return 400, errBody("can't rename the share itself")
	}
	if _, err := os.Lstat(dst); err == nil {
		return 409, errBody("already exists")
	}
	was := RelOf(*sh, src)
	if err := os.Rename(src, dst); err != nil {
		return 500, errBody(err.Error())
	}
	changed(*sh, "rename", was, RelOf(*sh, dst))
	return 200, map[string]any{"ok": true, "path": RelOf(*sh, dst)}
}

// Remove recursively, never the share itself
func Remove(sh *Share, rel string) (int, any) {
	if !Can(sh, "d") {
		return 403, errBody("deleting is off for this share")
	}
	abs := SafePath(*sh, rel, true)
	if abs == "" {
		return 400, errBody("bad path")
	}
	if abs == sh.Real {
		return 400, errBody("can't delete the share itself")
	}
	if err := os.RemoveAll(abs); err != nil {
		return 500, errBody(err.Error())
	}
	changed(*sh, "delete", RelOf(*sh, abs), "")
	return 200, map[string]any{"ok": true}
}

// Pending what phosphorus.ini asks for against what is mounted
func Pending() bool {
	home := HostPathOf("/repo")
	if home == "" {
		return false
	}
	norm := func(d string) string {
		p := HostSpelling(strings.TrimSpace(d))
		abs := p
		if !absRe.MatchString(p) {
			abs = path.Join(home, p)
		}
		return trailRe.ReplaceAllString(path.Clean(abs), "$1")
	}
	join := func(ds []string) string {
		out := []string{}
		for _, d := range ds {
			if d != "" {
				out = append(out, norm(d))
			}
		}
		return strings.Join(out, ",")
	}
	want := join(ConfiguredDirs())
	have := mountedDirs()
	if len(have) == 0 {
		have = []string{os.Getenv("PHOSPHORUS_FILES_DIR")}
	}
	h := join(have)
	return want != "" && h != "" && want != h
}

// Who {user, admin} off the session, nil without one
type Who struct {
	User  string
	Admin bool
}

func firstSeg(rel string) string {
	p := path.Clean("/" + strings.ReplaceAll(rel, `\`, "/"))
	parts := strings.Split(p, "/")
	if len(parts) < 2 {
		return ""
	}
	return strings.ToLower(parts[1])
}

func ensureHome(user string) {
	desk := filepath.Join(HomeRoot, user, Desktop)
	if !exists(desk) {
		os.MkdirAll(desk, 0o755)
	}
}

// HomeGate "" when who may reach rel, else why not
func HomeGate(who *Who, rel string, isUser func(string) bool) string {
	if who == nil {
		return "log in to reach home"
	}
	seg := firstSeg(rel)
	if who.User != "" {
		ensureHome(who.User)
	}
	if seg == Sys {
		return "the system's alone"
	}
	if seg == "" || seg == who.User || seg == Shared {
		return ""
	}
	if isUser(seg) {
		return "another user's home"
	}
	if who.Admin {
		return ""
	}
	return "admins only"
}

// HomeFilterList a listing cut to what who may reach
func HomeFilterList(who *Who, rel string, entries []Entry, isUser func(string) bool) []Entry {
	out := []Entry{}
	for _, e := range entries {
		full := e.Name
		if rel != "" {
			full = rel + "/" + e.Name
		}
		if HomeGate(who, full, isUser) == "" {
			out = append(out, e)
		}
	}
	return out
}

// HomeFilterTree a tree's paths off the share's root
func HomeFilterTree(who *Who, entries []map[string]any, isUser func(string) bool) []map[string]any {
	out := []map[string]any{}
	for _, e := range entries {
		p, _ := e["path"].(string)
		if HomeGate(who, p, isUser) == "" {
			out = append(out, e)
		}
	}
	return out
}
