package cli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"github.com/pmghartman/phosphorus/internal/services"
)

// --- config files ---------------------------------------------------------------
// section-level edits, comments, order and every other section kept

type section struct {
	name  string
	lines []string
}

type doc struct {
	head []string
	secs []*section
}

var (
	headRe    = regexp.MustCompile(`^\[\s*(.*?)\s*\]$`)
	newlineRe = regexp.MustCompile(`\r?\n`)
	quotesRe  = regexp.MustCompile(`^"|"$`)
)

func splitSections(text string) *doc {
	d := &doc{}
	var cur *section
	for _, line := range newlineRe.Split(text, -1) {
		if m := headRe.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			cur = &section{name: m[1], lines: []string{line}}
			d.secs = append(d.secs, cur)
			continue
		}
		if cur != nil {
			cur.lines = append(cur.lines, line)
		} else {
			d.head = append(d.head, line)
		}
	}
	return d
}

func (d *doc) join() string {
	all := append([]string{}, d.head...)
	for _, s := range d.secs {
		all = append(all, s.lines...)
	}
	return strings.Join(all, "\n")
}

func (d *doc) find(name string) *section {
	for _, s := range d.secs {
		if s.name == name {
			return s
		}
	}
	return nil
}

func keyOf(line string) string {
	t := strings.TrimSpace(line)
	eq := strings.Index(t, "=")
	if t == "" || t[0] == '#' || t[0] == ';' || eq <= 0 {
		return ""
	}
	return strings.TrimSpace(t[:eq])
}

func fieldsOf(s *section) map[string]string {
	f := map[string]string{}
	if s == nil {
		return f
	}
	for _, line := range s.lines[1:] {
		if k := keyOf(line); k != "" {
			f[k] = quotesRe.ReplaceAllString(strings.TrimSpace(line[strings.Index(line, "=")+1:]), "")
		}
	}
	return f
}

func sp(s string) *string { return &s }

// vals key to value, nil drops the key, absent untouched, new keys after the last
func rewriteSection(s *section, name string, vals map[string]*string, order []string) []string {
	out := []string{"[" + name + "]"}
	done := map[string]bool{}
	after := 1
	for _, line := range s.lines[1:] {
		k := keyOf(line)
		if v, ok := vals[k]; k != "" && ok {
			done[k] = true
			if v != nil {
				out = append(out, strings.TrimRight(k+" = "+*v, " \t"))
				after = len(out)
			}
			continue
		}
		out = append(out, line)
		if k != "" {
			after = len(out)
		}
	}
	extra := []string{}
	for _, k := range order {
		if v := vals[k]; !done[k] && v != nil {
			extra = append(extra, strings.TrimRight(k+" = "+*v, " \t"))
		}
	}
	return append(out[:after:after], append(extra, out[after:]...)...)
}

// one blank line before it, one trailing newline after
func (d *doc) appendSection(name string) *section {
	last := &d.head
	if len(d.secs) > 0 {
		last = &d.secs[len(d.secs)-1].lines
	}
	for len(*last) > 0 && strings.TrimSpace((*last)[len(*last)-1]) == "" {
		*last = (*last)[:len(*last)-1]
	}
	if len(*last) > 0 {
		*last = append(*last, "")
	}
	s := &section{name: name, lines: []string{"[" + name + "]", ""}}
	d.secs = append(d.secs, s)
	return s
}

func readText(file string) string {
	b, _ := os.ReadFile(file)
	return string(b)
}

// temp then rename, owner and mode kept, else a root-owned file in the host's home
func writeAtomic(file, text string) error {
	st, statErr := os.Stat(file)
	tmp := filepath.Join(filepath.Dir(file), fmt.Sprintf(".%s.phosphorus-%d", filepath.Base(file), os.Getpid()))
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	err := func() error {
		if statErr == nil {
			if err := os.Chmod(tmp, st.Mode().Perm()|st.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky)); err != nil {
				return err
			}
			if err := chownLike(tmp, st); err != nil {
				return err
			}
		}
		return os.Rename(tmp, file)
	}()
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

func writeDoc(file string, d *doc) string {
	if err := writeAtomic(file, d.join()); err != nil {
		return fmt.Sprintf("can't write %s: %s", file, errText(err))
	}
	return ""
}

func errText(err error) string {
	if pe, ok := err.(*os.PathError); ok {
		return pe.Err.Error()
	}
	return err.Error()
}

// --- forms ----------------------------------------------------------------------

type field struct {
	key, value, hint string
	choices          []string
	// typed and pasted, never drawn
	secret bool
}

type form struct {
	kind, title string
	// the service's section, or the share's index, -1 for new
	orig    string
	isNew   bool
	origIdx int
	idx     int
	err     string
	fields  []*field
	initial string
	gpuWas  string
	hostWas string
	first   bool
}

func (f *form) values() string {
	vs := []string{}
	for _, x := range f.fields {
		vs = append(vs, x.value)
	}
	b, _ := json.Marshal(vs)
	return string(b)
}

func (f *form) vals() map[string]string {
	v := map[string]string{}
	for _, x := range f.fields {
		v[x.key] = strings.TrimSpace(x.value)
	}
	return v
}

func indexOf(xs []string, x string) int {
	for i, y := range xs {
		if y == x {
			return i
		}
	}
	return -1
}

// --- services.export ------------------------------------------------------------

var svcKeys = []string{"port", "scheme", "mode", "base_path", "extras", "type", "start", "stop", "public"}

func serviceForm(s *section) *form {
	f := fieldsOf(s)
	fl := func(key, hint string, choices ...string) *field {
		return &field{key: key, value: f[key], hint: hint, choices: choices}
	}
	out := &form{kind: "service", title: "new service", isNew: s == nil}
	name := ""
	if s != nil {
		out.title = "editing [" + s.name + "]"
		out.orig = s.name
		name = s.name
	}
	out.fields = []*field{
		{key: "name", value: name, hint: "lowercase letters, digits, -"},
		fl("port", "required, 1-65535"),
		fl("scheme", "blank = http", "", "http", "https"),
		fl("mode", "blank = path, subdomain = <name>.<domain>, a path without one", "", "path", "subdomain"),
		fl("base_path", "sub-path stripped before proxying"),
		fl("extras", `JSON: {"max_body":"50MB","forwarded_proto":"https"}`),
		fl("public", "true = no phosphorus login, the service's own only", "", "true", "false"),
		fl("type", "blank, or game", "", "game"),
		fl("start", "games only: host command behind play"),
		fl("stop", "games only: host command behind stop"),
	}
	return out
}

// the neighbouring service in file order, unsaved changes asked about first
func switchService(dir int) {
	f := ui.form
	secs := splitSections(readText(servicesFile)).secs
	n := len(secs)
	if n == 0 {
		return
	}
	at := -1
	if f.isNew {
		if dir < 0 {
			at = n
		}
	} else {
		for i, s := range secs {
			if s.name == f.orig {
				at = i
			}
		}
	}
	next := ((at+dir)%n + n) % n
	goTo := func() {
		ui.sel[servicesTab] = next
		idx := f.idx
		openForm(serviceForm(secs[next]))
		ui.form.idx = idx
	}
	if f.values() == f.initial {
		goTo()
		return
	}
	what := "the new service"
	if !f.isNew {
		what = "[" + f.orig + "]"
	}
	ui.confirm = &confirm{text: "discard changes to " + what + "?", danger: true, onYes: goTo}
}

// the whole candidate file through the frontend's own parser, a bad edit never
// reaching disk to blackhole the file
func saveService(f *form) string {
	v := f.vals()
	if v["name"] == "" {
		return "name is required"
	}
	if v["port"] == "" {
		return "port is required"
	}
	if v["type"] == "game" && (v["start"] == "") != (v["stop"] == "") {
		return "start and stop go together"
	}
	if v["type"] != "game" && (v["start"] != "" || v["stop"] != "") {
		return "start and stop are for games only"
	}
	if v["type"] == "game" && v["public"] != "" {
		return "public is for web services only"
	}
	d := splitSections(readText(servicesFile))
	var s *section
	if !f.isNew {
		if s = d.find(f.orig); s == nil {
			return "[" + f.orig + "] is gone from the file, reopen it"
		}
	}
	if s == nil {
		s = d.appendSection(v["name"])
	}
	vals := map[string]*string{}
	for _, k := range svcKeys {
		vals[k] = nil
		if v[k] != "" {
			vals[k] = sp(v[k])
		}
	}
	s.lines = rewriteSection(s, v["name"], vals, svcKeys)
	return commitServices(d)
}

func deleteService(name string) string {
	d := splitSections(readText(servicesFile))
	kept := d.secs[:0]
	for _, s := range d.secs {
		if s.name != name {
			kept = append(kept, s)
		}
	}
	d.secs = kept
	return commitServices(d)
}

func commitServices(d *doc) string {
	if _, err := services.Parse(d.join()); err != "" {
		return err
	}
	return writeDoc(servicesFile, d)
}

// --- phosphorus.ini [files] -----------------------------------------------------

type share struct{ dir, perms string }

func splitList(v string) []string {
	out := []string{}
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// unset perms full access, as the frontend reads them
func readShares() []share {
	f := fieldsOf(splitSections(readText(iniFile)).find("files"))
	perms := splitList(f["priv"])
	out := []share{}
	for i, d := range splitList(f["dir"]) {
		p := "rwd"
		if i < len(perms) {
			p = perms[i]
		}
		out = append(out, share{d, p})
	}
	return out
}

func iniSection(d *doc, name string) *section {
	if s := d.find(name); s != nil {
		return s
	}
	return d.appendSection(name)
}

func writeShares(shares []share) string {
	d := splitSections(readText(iniFile))
	s := iniSection(d, "files")
	vals := map[string]*string{"dir": sp(""), "priv": nil}
	if len(shares) > 0 {
		dirs, perms := []string{}, []string{}
		for _, x := range shares {
			dirs = append(dirs, x.dir)
			perms = append(perms, x.perms)
		}
		vals = map[string]*string{"dir": sp(strings.Join(dirs, ", ")), "priv": sp(strings.Join(perms, ", "))}
	}
	s.lines = rewriteSection(s, "files", vals, []string{"dir", "priv"})
	return writeDoc(iniFile, d)
}

func shareForm(i int) *form {
	s := share{}
	title := "new share"
	if i >= 0 {
		s = readShares()[i]
		title = "edit share " + s.dir
	}
	return &form{kind: "share", title: title, origIdx: i, isNew: i < 0, fields: []*field{
		{key: "dir", value: s.dir, hint: "host path, never / or a home directory"},
		{key: "perms", value: s.perms, hint: "r browse, w upload/rename, d delete", choices: []string{"r", "rw", "rwd"}},
	}}
}

var permsRe = regexp.MustCompile(`^[rwd]+$`)

func saveShare(f *form) string {
	dir, perms := strings.TrimSpace(f.fields[0].value), strings.TrimSpace(f.fields[1].value)
	if dir == "" {
		return "dir is required"
	}
	if strings.Contains(dir, ",") {
		return "dir can't contain a comma"
	}
	if !permsRe.MatchString(perms) || strings.Count(perms, "r") > 1 || strings.Count(perms, "w") > 1 || strings.Count(perms, "d") > 1 {
		return "perms is a mix of r, w and d"
	}
	shares := readShares()
	wasHome := !f.isNew && isHomeDir(shares[f.origIdx].dir)
	if f.isNew {
		shares = append(shares, share{dir, perms})
	} else {
		shares[f.origIdx] = share{dir, perms}
	}
	if err := writeShares(shares); err != "" {
		return err
	}
	if wasHome {
		return writeHomeDir(dir)
	}
	return ""
}

// --- phosphorus.ini [home] ------------------------------------------------------
// the [files] dir whose home/ holds the users, shared/ and .sys/, blank the home's
// files/, a change moving home/ there on the rebuild

func homeKey(d string) string { return strings.TrimRight(strings.TrimSpace(d), `/\`) }

func readHomeDir() string {
	s := splitSections(readText(iniFile)).find("home")
	if s == nil {
		return ""
	}
	return homeKey(fieldsOf(s)["dir"])
}

func writeHomeDir(dir string) string {
	d := splitSections(readText(iniFile))
	s := iniSection(d, "home")
	s.lines = rewriteSection(s, "home", map[string]*string{"dir": sp(homeKey(dir))}, []string{"dir"})
	return writeDoc(iniFile, d)
}

func isHomeDir(dir string) bool {
	h := readHomeDir()
	return h != "" && homeKey(dir) == h
}

// --- phosphorus.ini [git] -------------------------------------------------------

func readGitHost() bool {
	s := splitSections(readText(iniFile)).find("git")
	return runtime.GOOS == "linux" && s != nil && fieldsOf(s)["host"] == "true"
}

func writeGitHost(on bool) string {
	if on && runtime.GOOS != "linux" {
		return "git hosts run on Linux alone: forgejo and the git daemon ship for it only"
	}
	d := splitSections(readText(iniFile))
	s := iniSection(d, "git")
	s.lines = rewriteSection(s, "git", map[string]*string{"host": sp(strconv.FormatBool(on))}, []string{"host"})
	return writeDoc(iniFile, d)
}

// --- phosphorus.ini [model] -----------------------------------------------------

// host, gpu and url always written, ctx and slots only once set
var (
	modelKeys = []string{"host", "gpu", "url", "ctx", "slots"}
	modelKept = map[string]bool{"host": true, "gpu": true, "url": true}
	boolKeys  = []string{"host", "gpu"}
)

func readModel() map[string]string {
	f := fieldsOf(splitSections(readText(iniFile)).find("model"))
	out := map[string]string{}
	for _, k := range modelKeys {
		out[k] = f[k]
		// flags never blank, the form's choices always somewhere to start
		if out[k] == "" && (k == "host" || k == "gpu") {
			out[k] = "false"
		}
	}
	return out
}

func writeModel(vals map[string]string) string {
	d := splitSections(readText(iniFile))
	s := iniSection(d, "model")
	out := map[string]*string{}
	for _, k := range modelKeys {
		v := strings.TrimSpace(vals[k])
		switch {
		case v != "":
			out[k] = sp(v)
		case modelKept[k]:
			out[k] = sp("")
		default:
			out[k] = nil
		}
	}
	s.lines = rewriteSection(s, "model", out, modelKeys)
	return writeDoc(iniFile, d)
}

var roles = []string{"chimp", "orangutan"}

func modelForm() *form {
	m := readModel()
	fl := func(key, hint string, choices ...string) *field {
		return &field{key: key, value: m[key], hint: hint, choices: choices}
	}
	return &form{kind: "model", title: "[model]", gpuWas: m["gpu"], hostWas: m["host"], fields: []*field{
		fl("host", "true runs the model here for the whole mesh, downloading llama.cpp's llama-server (with NVIDIA's CUDA runtime on an nvidia gpu) and the model itself, several GB", "false", "true"),
		fl("gpu", "true offloads it to this nvidia, amd or intel gpu, the rest in ram", "false", "true"),
		fl("url", "download link to a single .gguf, pasted or typed, a hugging face page link works too"),
		fl("ctx", "context tokens, blank is 65536, and every token costs memory"),
		fl("slots", "asks answered at once, sharing ctx, blank is 4"),
	}}
}

// as the daemon reads it: https, a path ending .gguf
func linkOk(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return false
	}
	return strings.HasSuffix(u.Path, ".gguf")
}

// JS Number() of a form value: whole and at least lo
func wholeAtLeast(v string, lo float64) bool {
	n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	return err == nil && n == float64(int64(n)) && n >= lo
}

func saveModel(f *form) string {
	v := readModel()
	for k, x := range f.vals() {
		v[k] = x
	}
	if v["ctx"] != "" && !wholeAtLeast(v["ctx"], 512) {
		return "ctx is a whole number of tokens, 512 or more"
	}
	for _, k := range boolKeys {
		if v[k] != "true" && v[k] != "false" {
			return k + " is true or false"
		}
	}
	if v["slots"] != "" && !wholeAtLeast(v["slots"], 1) {
		return "slots is a whole number, 1 or more"
	}
	if v["url"] != "" && !linkOk(v["url"]) {
		return "url is a https link to a single .gguf"
	}
	return writeModel(v)
}

// --- edits from the frontend: the same rewrites as the forms ---------------------

var svcNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// SetService [name] written with fields, a blank one dropped, or removed; "" once saved
func SetService(name string, fields map[string]string, remove bool) string {
	why, _ := EditService(name, fields, remove, false)
	return why
}

// EditService SetService, or with dry the change it would make as a diff, nothing written
func EditService(name string, fields map[string]string, remove, dry bool) (string, string) {
	if !svcNameRe.MatchString(name) {
		return "name: lowercase letters, digits, -", ""
	}
	before := readText(servicesFile)
	d := splitSections(before)
	s := d.find(name)
	if remove {
		if s == nil {
			return "no service " + name, ""
		}
		kept := d.secs[:0]
		for _, x := range d.secs {
			if x.name != name {
				kept = append(kept, x)
			}
		}
		d.secs = kept
		return commitDry(d, before, dry)
	}
	v := fieldsOf(s)
	for k, x := range fields {
		known := false
		for _, sk := range svcKeys {
			known = known || sk == k
		}
		if !known {
			return "no field " + k + ", only " + strings.Join(svcKeys, ", "), ""
		}
		v[k] = strings.TrimSpace(x)
	}
	if v["port"] == "" {
		return "port is required", ""
	}
	if v["type"] == "game" && (v["start"] == "") != (v["stop"] == "") {
		return "start and stop go together", ""
	}
	if v["type"] != "game" && (v["start"] != "" || v["stop"] != "") {
		return "start and stop are for games only", ""
	}
	if s == nil {
		s = d.appendSection(name)
	}
	vals := map[string]*string{}
	for _, k := range svcKeys {
		vals[k] = nil
		if v[k] != "" {
			vals[k] = sp(v[k])
		}
	}
	s.lines = rewriteSection(s, name, vals, svcKeys)
	return commitDry(d, before, dry)
}

// commitDry services.export checked, then written, or only diffed when dry
func commitDry(d *doc, before string, dry bool) (string, string) {
	if _, err := services.Parse(d.join()); err != "" {
		return err, ""
	}
	diff := LineDiff(before, d.join())
	if dry {
		return "", diff
	}
	return writeDoc(servicesFile, d), diff
}

// IniKeys the phosphorus.ini keys phosphorus reads, by section
var IniKeys = map[string][]string{
	"files": {"dir", "priv"},
	"git":   {"host"},
	"model": {"host", "gpu", "url", "ctx", "slots"},
	"home":  {"dir"},
}

// SetIni phosphorus.ini's section key set, blank dropping it; "" once saved
func SetIni(section, key, value string) string {
	why, _ := EditIni(section, key, value, false)
	return why
}

// EditIni SetIni held to IniKeys, a section left empty removed, or with dry
// the change it would make as a diff
func EditIni(section, key, value string, dry bool) (string, string) {
	keys, ok := IniKeys[section]
	if !ok {
		names := []string{}
		for k := range IniKeys {
			names = append(names, k)
		}
		sort.Strings(names)
		return "no section " + section + ", only " + strings.Join(names, ", "), ""
	}
	if indexOf(keys, key) < 0 {
		return "no key " + key + " in [" + section + "], only " + strings.Join(keys, ", "), ""
	}
	if strings.ContainsAny(value, "\n\r") {
		return "one line only", ""
	}
	before := readText(iniFile)
	d := splitSections(before)
	s := iniSection(d, section)
	var v *string
	if value = strings.TrimSpace(value); value != "" {
		v = sp(value)
	}
	s.lines = rewriteSection(s, section, map[string]*string{key: v}, []string{key})
	// a header with no keys left dropped, its blank lines with it
	if len(fieldsOf(s)) == 0 {
		kept := d.secs[:0]
		for _, x := range d.secs {
			if x != s {
				kept = append(kept, x)
			}
		}
		d.secs = kept
	}
	diff := LineDiff(before, d.join())
	if dry {
		return "", diff
	}
	return writeDoc(iniFile, d), diff
}

// LineDiff the lines b changed from a, "- " gone and "+ " new, unchanged left out
func LineDiff(a, b string) string {
	lines := func(t string) []string {
		if t = strings.TrimRight(t, "\n"); t == "" {
			return nil
		}
		return strings.Split(t, "\n")
	}
	x, y := lines(a), lines(b)
	n, m := len(x), len(y)
	l := make([][]int, n+1)
	for i := range l {
		l[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if x[i] == y[j] {
				l[i][j] = l[i+1][j+1] + 1
			} else {
				l[i][j] = max(l[i+1][j], l[i][j+1])
			}
		}
	}
	out := []string{}
	i, j := 0, 0
	for i < n || j < m {
		switch {
		case i < n && j < m && x[i] == y[j]:
			i, j = i+1, j+1
		case j < m && (i == n || l[i][j+1] >= l[i+1][j]):
			if strings.TrimSpace(y[j]) != "" {
				out = append(out, "+ "+y[j])
			}
			j++
		default:
			if strings.TrimSpace(x[i]) != "" {
				out = append(out, "- "+x[i])
			}
			i++
		}
	}
	return strings.Join(out, "\n")
}

// ConfigText phosphorus.ini and services.export as they stand
func ConfigText() (string, string) { return readText(iniFile), readText(servicesFile) }
