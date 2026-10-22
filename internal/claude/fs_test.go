package claude

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseLs(t *testing.T) {
	out := "/home/pmh\x00fzeta.txt\x00dsrc\x00fodd\nname\x00dAlpha\x00\x00" + "12 1700000000\n4096 1700000001\n3 5\n4096 7\n"
	dir, ents, more, err := parseLs([]byte(out))
	if err != nil || dir != "/home/pmh" || more {
		t.Fatal(dir, more, err)
	}
	want := []Entry{{"Alpha", true, 4096, 7000}, {"src", true, 4096, 1700000001000}, {"odd\nname", false, 3, 5000}, {"zeta.txt", false, 12, 1700000000000}}
	if len(ents) != len(want) {
		t.Fatalf("%+v", ents)
	}
	for i := range want {
		if ents[i] != want[i] {
			t.Errorf("%d: %+v, want %+v", i, ents[i], want[i])
		}
	}
	// stat lines that don't line up dropped, the names kept; more flagged
	_, ents, more, err = parseLs([]byte("/x\x00fa\x00fb\x001\x00" + "1 2\n"))
	if err != nil || !more || len(ents) != 2 || ents[0].Size != 0 {
		t.Fatalf("%+v %v %v", ents, more, err)
	}
	for _, bad := range []string{"", "relative\x00\x00", "/x\x00fa"} {
		if _, _, _, err := parseLs([]byte(bad)); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestDupNames(t *testing.T) {
	got := dupNames("shot.final.png", 2)
	if strings.Join(got, "|") != "shot.final.png|shot.final (1).png|shot.final (2).png" {
		t.Fatal(got)
	}
	if got := dupNames(".env", 1); got[1] != ".env (1)" {
		t.Fatal(got)
	}
	if got := dupNames("README", 1); got[1] != "README (1)" {
		t.Fatal(got)
	}
	for n, ok := range map[string]bool{"a.txt": true, "it's $(x).txt": true, "": false, ".": false, "..": false, "a/b": false, "a\nb": false} {
		if okName(n) != ok {
			t.Errorf("okName(%q) %v", n, !ok)
		}
	}
	for d, ok := range map[string]bool{"": true, "~": true, "~/x": true, "/x": true, "x": false, "~x": false, "/a\nb": false} {
		if okDir(d) != ok {
			t.Errorf("okDir(%q) %v", d, !ok)
		}
	}
}

// the scripts run by a local sh in place of the login shell, paths that
// would break or inject if spliced in
func TestFsScriptsRun(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no sh")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	home := t.TempDir()
	odd := filepath.Join(home, `it's $(touch pwned) "x"`)
	os.MkdirAll(filepath.Join(odd, "sub dir"), 0o755)
	os.MkdirAll(filepath.Join(odd, ".hidden"), 0o755)
	os.WriteFile(filepath.Join(odd, "-rf"), []byte("abc"), 0o644)
	os.WriteFile(filepath.Join(odd, "new\nline"), nil, 0o644)
	os.Symlink("/nowhere", filepath.Join(odd, "dangling"))
	sh := func(cmd, stdin string) (string, int) {
		c := exec.Command("sh", "-c", cmd)
		c.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
		c.Dir = home
		c.Stdin = strings.NewReader(stdin)
		out, _ := c.Output()
		return string(out), c.ProcessState.ExitCode()
	}
	out, code := sh(lsCommand("~/"+filepath.Base(odd)), "")
	if code != 0 {
		t.Fatal(code, out)
	}
	dir, ents, more, err := parseLs([]byte(out))
	if err != nil || more {
		t.Fatal(err, more, out)
	}
	if r, _ := filepath.EvalSymlinks(odd); dir != r {
		t.Errorf("dir %q", dir)
	}
	names := []string{}
	for _, e := range ents {
		names = append(names, e.Name)
		if e.Name == "-rf" && (e.Size != 3 || e.MTime == 0 || e.Dir) {
			t.Errorf("-rf %+v", e)
		}
	}
	if strings.Join(names, "|") != ".hidden|sub dir|-rf|dangling|new\nline" {
		t.Errorf("names %q", names)
	}
	if _, err := os.Stat(filepath.Join(home, "pwned")); err == nil {
		t.Fatal("injected")
	}
	// home by default, an empty folder, a missing one
	if out, _ := sh(lsCommand(""), ""); !strings.HasPrefix(out, home) && !strings.Contains(out, filepath.Base(home)) {
		t.Errorf("home %q", out)
	}
	if out, code := sh(lsCommand(filepath.Join(odd, "sub dir")), ""); code != 0 || !strings.HasSuffix(out, "sub dir\x00\x00") {
		t.Errorf("empty %d %q", code, out)
	}
	if _, code := sh(lsCommand("/nowhere/at/all"), ""); code != 3 {
		t.Errorf("missing %d", code)
	}
	// uploads: the name, then "name (1)", never overwriting
	for i, want := range []string{"a b.txt", "a b (1).txt", "a b (2).txt"} {
		out, code := sh(uploadCommand(odd, 5, dupNames("a b.txt", 2)), "hello")
		if code != 0 || filepath.Base(out) != want {
			t.Fatalf("%d: %d %q", i, code, out)
		}
	}
	if _, code := sh(uploadCommand(odd, 5, dupNames("a b.txt", 2)), "hello"); code != 4 {
		t.Errorf("all taken %d", code)
	}
	if b, _ := os.ReadFile(filepath.Join(odd, "a b.txt")); string(b) != "hello" {
		t.Errorf("first %q", b)
	}
	// cut short: gone again
	if _, code := sh(uploadCommand(odd, 9, dupNames("short.bin", 1)), "abc"); code != 5 {
		t.Errorf("short %d", code)
	}
	if _, err := os.Stat(filepath.Join(odd, "short.bin")); err == nil {
		t.Error("short upload kept")
	}
	if out, code := sh(uploadCommand("~/"+filepath.Base(odd), 2, []string{"$(touch pwned)"}), "hi"); code != 0 || !strings.HasSuffix(out, "/$(touch pwned)") {
		t.Errorf("odd name %d %q", code, out)
	}
	if _, err := os.Stat(filepath.Join(home, "pwned")); err == nil {
		t.Fatal("injected")
	}
}
