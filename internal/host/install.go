package host

import (
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pmghartman/phosphorus/internal/envfile"
)

// install the release into the home, per-host files kept, then the bring-up
// or, for an update, the rebuild; no keys yet: left for the key form
func install(payload string, update bool) error {
	if payload == "" {
		// the package's bin/phosphorus, beside the release it came with
		payload = filepath.Dir(filepath.Dir(exe()))
	}
	payload, _ = filepath.Abs(payload)
	h, _ := filepath.Abs(home)
	if fileExists(filepath.Join(payload, ".git")) {
		return fail("%s is a git clone, not a release: install from the latest release", payload)
	}
	if !fileExists(filepath.Join(payload, "VERSION")) {
		return fail("%s holds no release", payload)
	}
	if strings.EqualFold(payload, h) {
		return fail("run the package's copy, not %s's", home)
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		return fail("can't create %s", home)
	}
	if err := syncPayload(payload, home); err != nil {
		return fail("couldn't copy the release into %s: %v", home, err)
	}
	if err := installSelf(); err != nil {
		return fail("couldn't put phosphorus in %s: %v", at("bin"), err)
	}
	v := version()
	say("phosphorus %s in %s", v, home)
	if err := envfile.Ensure(envPath()); err != nil {
		return fail("can't lock %s: %v", envPath(), err)
	}
	if keysMissing() {
		say("no keys yet: run phosphorus (or open the Phosphorus app) to enter them")
		return os.WriteFile(at(".phosphorus-installed"), []byte(v+"\n"), 0o644)
	}
	var err error
	if update {
		err = rebuild()
		if err != nil {
			err = fail("rebuild failed, still running the previous version: %v", err)
		}
	} else {
		err = start()
	}
	if err != nil {
		return err
	}
	return os.WriteFile(at(".phosphorus-installed"), []byte(v+"\n"), 0o644)
}

// per host, never overwritten once there
func kept(f string) bool {
	return f == "config/services.export" || f == "config/phosphorus.ini" || strings.HasPrefix(f, "files/")
}

// every release file into dst, what the last one shipped and this one doesn't
// removed, this host's config and share left alone
func syncPayload(src, dst string) error {
	next := []string{}
	err := filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.HasPrefix(d.Name(), ".phosphorus-") {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		next = append(next, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return err
	}
	for _, f := range next {
		to := filepath.Join(dst, filepath.FromSlash(f))
		if kept(f) && fileExists(to) {
			continue
		}
		if err := copyFile(filepath.Join(src, filepath.FromSlash(f)), to); err != nil {
			return err
		}
	}
	// the binary, copied in by installSelf
	for _, n := range binNames() {
		next = append(next, "bin/"+filepath.Base(binPath(n)))
	}
	sort.Strings(next)
	manifest := filepath.Join(dst, ".phosphorus-manifest")
	want := map[string]bool{}
	for _, f := range next {
		want[f] = true
	}
	if b, err := os.ReadFile(manifest); err == nil {
		for _, f := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n") {
			if f == "" || want[f] || strings.HasPrefix(f, "config/") || strings.HasPrefix(f, "files/") {
				continue
			}
			p := filepath.Join(dst, filepath.FromSlash(f))
			os.Remove(p)
			// its folders too, once nothing else is in them
			for d := filepath.Dir(p); len(d) > len(dst) && os.Remove(d) == nil; d = filepath.Dir(d) {
			}
		}
	}
	return os.WriteFile(manifest, []byte(strings.Join(next, "\n")+"\n"), 0o644)
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	tmp := to + ".phosphorus-tmp"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, st.Mode().Perm()|0o644)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		os.Chtimes(tmp, st.ModTime(), st.ModTime())
		err = replace(tmp, to)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// replace to with tmp, a running Windows exe moved aside first
func replace(tmp, to string) error {
	if err := os.Rename(tmp, to); err == nil || !isWindows {
		return err
	}
	old := to + ".old"
	os.Remove(old)
	if err := os.Rename(to, old); err != nil {
		return err
	}
	return os.Rename(tmp, to)
}

// phos beside it on Windows, a second link elsewhere
func binNames() []string {
	if isWindows {
		return []string{"phosphorus", "phos"}
	}
	return []string{"phosphorus"}
}

// installSelf this binary into the home's bin/
func installSelf() error {
	self := exe()
	for _, n := range binNames() {
		to := binPath(n)
		if r, err := filepath.EvalSymlinks(to); err == nil && r == self {
			continue
		}
		if err := copyFile(self, to); err != nil {
			return err
		}
		os.Chmod(to, 0o755)
	}
	return nil
}
