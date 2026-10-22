package files

import (
	"os"
	"path/filepath"
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
