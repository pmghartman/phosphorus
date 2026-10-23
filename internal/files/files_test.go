package files

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// a share of a whole drive or the root holds what's under it, its separator already its own
func TestInsideRoot(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.VolumeName(wd) + string(filepath.Separator)
	sh := Share{Real: root}
	if !inside(sh, root) || !inside(sh, wd) {
		t.Fatalf("%s not inside %s", wd, root)
	}
	dir := Share{Real: wd}
	if !inside(dir, filepath.Join(wd, "x")) || inside(dir, wd+"x") || inside(dir, filepath.Dir(wd)) {
		t.Fatal("a folder's share holds only what's in it")
	}
	if abs := toAbs(sh, "a/b"); abs != filepath.Join(root, "a", "b") {
		t.Fatalf("toAbs %q", abs)
	}
}

func TestSystemFolderIsAdminsOnly(t *testing.T) {
	isUser := func(s string) bool { return s == "ann" || s == "bob" }
	admin := &Who{User: "root", Admin: true}
	ann := &Who{User: "ann"}
	for _, rel := range []string{"/.sys", "/.sys/etc/x.json", "/.SYS/home/ann/prefs.json"} {
		if why := HomeGate(admin, rel, isUser); why != "" {
			t.Errorf("admin refused %s: %s", rel, why)
		}
		if why := HomeGate(ann, rel, isUser); why != Gone {
			t.Errorf("a user reaching %s: %q, want it not there", rel, why)
		}
	}
	if HomeGate(ann, "/ann/notes.txt", isUser) != "" || HomeGate(ann, "/bob/notes.txt", isUser) == "" {
		t.Error("a user's own folder and another's")
	}
	if GateCode(ann, Gone) != 404 || GateCode(nil, "log in") != 401 || GateCode(ann, "admins only") != 403 {
		t.Error("gate codes")
	}
	entries := []Entry{{Name: ".sys", Dir: true}, {Name: "ann", Dir: true}, {Name: "shared", Dir: true}}
	names := func(es []Entry) string {
		var out []string
		for _, e := range es {
			out = append(out, e.Name)
		}
		return strings.Join(out, ",")
	}
	if got := names(HomeFilterList(ann, "", entries, isUser)); got != "ann,shared" {
		t.Errorf("a user sees %s", got)
	}
	// an admin sees the system's folder, though never another user's home
	if got := names(HomeFilterList(admin, "", entries, isUser)); got != ".sys,shared" {
		t.Errorf("an admin sees %s", got)
	}
}
