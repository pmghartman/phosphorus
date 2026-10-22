package code

// a host's folders over the user's own ssh login: a listing for the page's
// picker and browser, files uploaded in without overwriting; sh -c with the
// paths as its arguments, never spliced into the script

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/crypto/ssh"
)

const (
	// lsMax entries a listing holds, the rest only counted as more
	lsMax = 2000
	// lsOut a listing's output kept at most
	lsOut = 4 << 20
	// UploadMax one upload's bytes
	UploadMax = 50 << 20
	// dupMax "name (n).ext" tried up to n
	dupMax = 99
)

// Entry one name in a listing
type Entry struct {
	Name  string `json:"name"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"`
}

// dirPrelude $1 as a folder: "" and ~ its home, ~/x under it; then cd'd
// into, exit 3 when it can't be
const dirPrelude = `d=$1; shift; case $d in "" | "~") d=$HOME ;; "~/"*) d=$HOME/${d#"~/"} ;; esac; ` +
	`cd -- "$d" 2>/dev/null || exit 3; `

// lsCommand a listing of dir: its resolved path, then each name tagged d or
// f, NUL ended, an empty one closing them; then lstat's size and mtime, a line
// per name in the same order, GNU's stat or BSD's
func lsCommand(dir string) string {
	script := dirPrelude + `printf '%s\000' "$(pwd -P)"; n=0; more=; ` +
		`for f in .[!.]* ..?* *; do [ -e "$f" ] || [ -L "$f" ] || continue; n=$((n+1)); ` +
		`if [ $n -gt ` + strconv.Itoa(lsMax) + ` ]; then more=1; break; fi; set -- "$@" "$f"; done; ` +
		`for f in "$@"; do if [ -d "$f" ]; then printf 'd%s\000' "$f"; else printf 'f%s\000' "$f"; fi; done; ` +
		`printf '%s\000' "$more"; [ $# -eq 0 ] && exit 0; ` +
		`stat -c '%s %Y' -- "$@" 2>/dev/null || stat -f '%z %m' -- "$@" 2>/dev/null; exit 0`
	return "sh -c " + quote(script) + " sh " + quote(dir)
}

// parseLs lsCommand's output: the folder, its entries folders first, whether
// there were more
func parseLs(out []byte) (string, []Entry, bool, error) {
	parts := bytes.Split(out, []byte{0})
	if len(parts) < 3 || len(parts[0]) == 0 || parts[0][0] != '/' {
		return "", nil, false, errors.New("unreadable listing")
	}
	dir := string(parts[0])
	ents := []Entry{}
	i := 1
	for ; i < len(parts); i++ {
		p := parts[i]
		if len(p) < 2 || (p[0] != 'd' && p[0] != 'f') {
			break
		}
		ents = append(ents, Entry{Name: string(p[1:]), Dir: p[0] == 'd'})
	}
	if i >= len(parts) {
		return "", nil, false, errors.New("unreadable listing")
	}
	more := len(parts[i]) > 0
	// the stat lines, kept only when there's one per name
	rest := strings.TrimSpace(string(bytes.Join(parts[i+1:], nil)))
	if lines := strings.Split(rest, "\n"); rest != "" && len(lines) == len(ents) {
		for k, l := range lines {
			f := strings.Fields(l)
			if len(f) != 2 {
				continue
			}
			ents[k].Size, _ = strconv.ParseInt(f[0], 10, 64)
			if m, err := strconv.ParseInt(f[1], 10, 64); err == nil {
				ents[k].MTime = m * 1000
			}
		}
	}
	sort.SliceStable(ents, func(a, b int) bool {
		if ents[a].Dir != ents[b].Dir {
			return ents[a].Dir
		}
		return strings.ToLower(ents[a].Name) < strings.ToLower(ents[b].Name)
	})
	return dir, ents, more, nil
}

// uploadCommand stdin written into dir under the first of the names that
// isn't there yet, made with noclobber so nothing's overwritten; its path
// printed, the file gone again when it isn't size bytes
func uploadCommand(dir string, size int64, names []string) string {
	script := dirPrelude + `n=$1; shift; for f in "$@"; do ` +
		`if (set -C; : > "$f") 2>/dev/null; then cat > "$f" || { rm -f -- "$f"; exit 5; }; ` +
		`if [ "$(wc -c < "$f" | tr -d ' ')" != "$n" ]; then rm -f -- "$f"; exit 5; fi; ` +
		`printf '%s/%s' "$(pwd -P)" "$f"; exit 0; fi; done; exit 4`
	args := []string{quote(dir), strconv.FormatInt(size, 10)}
	for _, n := range names {
		args = append(args, quote(n))
	}
	return "sh -c " + quote(script) + " sh " + strings.Join(args, " ")
}

// dupNames name, then "name (1).ext" on to "name (n).ext"
func dupNames(name string, n int) []string {
	stem, ext := name, ""
	if i := strings.LastIndex(name, "."); i > 0 {
		stem, ext = name[:i], name[i:]
	}
	out := []string{name}
	for k := 1; k <= n; k++ {
		out = append(out, fmt.Sprintf("%s (%d)%s", stem, k, ext))
	}
	return out
}

// okName a file name as uploaded: no slash, no control character, not . or ..
func okName(n string) bool {
	if n == "" || n == "." || n == ".." || len(n) > 255 || strings.Contains(n, "/") {
		return false
	}
	for _, r := range n {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// okDir a folder as asked: absolute, or ~ and under it
func okDir(d string) bool {
	if len(d) > dirMax || strings.ContainsAny(d, "\x00\r\n") {
		return false
	}
	return d == "" || d == "~" || strings.HasPrefix(d, "~/") || strings.HasPrefix(d, "/")
}

// capture one command to its end, stdin fed it: its exit, stdout up to max,
// stderr's tail
func capture(c *ssh.Client, cmd string, stdin io.Reader, max int, timeout time.Duration) (int, []byte, string, error) {
	ss, err := c.NewSession()
	if err != nil {
		return -1, nil, "", err
	}
	defer ss.Close()
	out := &capped{max: max}
	errs := &tail{}
	ss.Stdout, ss.Stderr = out, errs
	if stdin != nil {
		ss.Stdin = stdin
	}
	done := make(chan error, 1)
	go func() { done <- ss.Run(cmd) }()
	select {
	case err = <-done:
	case <-time.After(timeout):
		ss.Signal(ssh.SIGKILL)
		return -1, nil, errs.String(), errors.New("timed out")
	}
	code := exitCode(err)
	if code == -1 {
		return code, out.b, errs.String(), err
	}
	return code, out.b, errs.String(), nil
}

// capped a writer keeping the first max bytes
type capped struct {
	b   []byte
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	if n := c.max - len(c.b); n > 0 {
		c.b = append(c.b, p[:min(n, len(p))]...)
	}
	return len(p), nil
}

// shellErr a host's shell refusing sh, a Windows one named
func shellErr(host string, code int, errs string) error {
	low := strings.ToLower(errs)
	if strings.Contains(low, "not recognized") || strings.Contains(low, "commandnotfound") {
		return fmt.Errorf("%s runs Windows, which Code doesn't support yet", host)
	}
	if errs == "" {
		return fmt.Errorf("on %s: exit %d", host, code)
	}
	return fmt.Errorf("on %s: %s", host, lastLine(errs))
}

// Ls a folder on host as the login: dir "" or ~ its home
func Ls(host, dir string, c Creds) (int, any) {
	if !hostRe.MatchString(host) {
		return 400, errB("pick a host")
	}
	if !okDir(dir) {
		return 400, errB("dir: an absolute path, or ~")
	}
	cl, err := dial(host, c.User, c.Pass)
	if err != nil {
		return 502, errB(err.Error())
	}
	defer cl.Close()
	code, out, errs, err := capture(cl, lsCommand(dir), nil, lsOut, 30*time.Second)
	switch {
	case err != nil:
		return 502, errB(err.Error())
	case code == 3:
		return 404, errB(fmt.Sprintf("can't open %s on %s", dir, host))
	case code != 0:
		return 502, errB(shellErr(host, code, errs).Error())
	}
	d, ents, more, err := parseLs(out)
	if err != nil {
		return 502, errB(shellErr(host, code, errs).Error())
	}
	return 200, map[string]any{"dir": d, "entries": ents, "more": more}
}

// Upload size bytes of body into dir on host as the login, under name or
// "name (n).ext" when that's taken
func Upload(host, dir, name string, size int64, body io.Reader, c Creds) (int, any) {
	name = strings.TrimSpace(name)
	switch {
	case !hostRe.MatchString(host):
		return 400, errB("pick a host")
	case !okDir(dir):
		return 400, errB("dir: an absolute path, or ~")
	case !okName(name):
		return 400, errB("name: a file name")
	case size < 0:
		return 411, errB("send the length")
	case size > UploadMax:
		return 413, errB("50MB at most")
	}
	cl, err := dial(host, c.User, c.Pass)
	if err != nil {
		return 502, errB(err.Error())
	}
	defer cl.Close()
	code, out, errs, err := capture(cl, uploadCommand(dir, size, dupNames(name, dupMax)), io.LimitReader(body, size), 64*1024, 10*time.Minute)
	switch {
	case err != nil:
		return 502, errB(err.Error())
	case code == 3:
		return 404, errB(fmt.Sprintf("can't open %s on %s", dir, host))
	case code == 4:
		return 409, errB("too many files named " + name + " there already")
	case code == 5:
		return 502, errB("the upload was cut short")
	case code != 0:
		return 502, errB(shellErr(host, code, errs).Error())
	}
	p := string(out)
	if !strings.HasPrefix(p, "/") {
		return 502, errB(shellErr(host, code, errs).Error())
	}
	return 200, map[string]any{"path": path.Clean(p)}
}
