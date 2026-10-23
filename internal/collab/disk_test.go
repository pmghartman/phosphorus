package collab

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pmghartman/phosphorus/internal/files"
)

// Run with go test ./internal/collab; these tests do not need a UI or watcher.
func diskFixture(t *testing.T, text string) (*session, string) {
	t.Helper()
	dir := t.TempDir()
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "App.cs")
	writeDiskFixture(t, path, text)
	share := files.Share{ID: dir, Root: dir, Real: real, Perms: "rw", OK: true}
	mu.Lock()
	s := newSession(keyOf(share, "App.cs"), share, "App.cs", text, 0)
	s.diskInfo = diskStat(share, "App.cs")
	t.Cleanup(func() {
		if s.autosave != nil {
			s.autosave.Stop()
		}
		delete(sessions, s.key)
		mu.Unlock()
	})
	return s, path
}

func writeDiskFixture(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	quiet := time.Now().Add(-time.Second)
	if err := os.Chtimes(path, quiet, quiet); err != nil {
		t.Fatal(err)
	}
}

func TestDiskReloadUsesOTAndRetainsCRLF(t *testing.T) {
	s, path := diskFixture(t, "class C\r\n{\r\n}\r\n")
	before := append([]uint16(nil), s.text...)
	c := &client{pos: len(s.text)}
	s.order = append(s.order, c)
	writeDiskFixture(t, path, "class Cat\r\n{\r\n    Run();\r\n}\r\n")
	s.observeDisk(readDisk(s.share, s.rel))
	if s.diskConflict || s.version != 1 || s.saved != 1 || s.eol != "\r\n" {
		t.Fatalf("reload state: %+v", s)
	}
	got, err := Apply(before, s.history[0])
	if err != nil || Str(got) != Str(s.text) || c.pos != len(s.text) {
		t.Fatal("disk edit did not map through OT")
	}
	b, _ := os.ReadFile(path)
	if string(b) != s.onDisk() {
		t.Fatal("reload changed line endings")
	}
}

func TestDiskConflictBlocksSaveAndRejectsStaleReview(t *testing.T) {
	s, path := diskFixture(t, "old")
	s.text, s.version = U16("editor draft"), 1
	writeDiskFixture(t, path, "disk version")
	if status, _ := s.saveNow(""); status != 409 || !s.diskConflict {
		t.Fatal("autosave overwrote external edit")
	}
	revision := s.diskRevision
	writeDiskFixture(t, path, "newer disk version")
	s.resolveDisk(&client{}, map[string]any{"choice": "keep", "revision": float64(revision)})
	b, _ := os.ReadFile(path)
	if string(b) != "newer disk version" || Str(s.text) != "editor draft" || !s.diskConflict {
		t.Fatal("stale review destroyed a version")
	}
	s.resolveDisk(&client{}, map[string]any{"choice": "reload", "revision": float64(s.diskRevision)})
	if Str(s.text) != "newer disk version" || s.saved != s.version || s.diskConflict {
		t.Fatal("reviewed reload failed")
	}
}

func TestDiskKeepCanRecreateDeletedFileAndHonorsReadOnly(t *testing.T) {
	s, path := diskFixture(t, "editor version")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	s.observeDisk(readDisk(s.share, s.rel))
	if !s.diskConflict || s.diskProblem == "" {
		t.Fatal("deletion lost editor version")
	}
	s.share.Perms = "r"
	s.resolveDisk(&client{}, map[string]any{"choice": "keep", "revision": float64(s.diskRevision)})
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("read-only share was written")
	}
	s.share.Perms = "rw"
	s.resolveDisk(&client{}, map[string]any{"choice": "keep", "revision": float64(s.diskRevision)})
	b, err := os.ReadFile(path)
	if err != nil || string(b) != "editor version" || s.diskConflict {
		t.Fatal("reviewed keep failed")
	}
}

func TestDiskIncompleteSnapshotAndMatchingDraft(t *testing.T) {
	s, path := diskFixture(t, "old")
	s.text, s.version = U16("draft"), 1
	s.observeDisk(diskSnapshot{valid: false, text: ""})
	if Str(s.text) != "draft" || s.diskConflict {
		t.Fatal("unstable disk snapshot applied")
	}
	writeDiskFixture(t, path, "draft")
	s.observeDisk(readDisk(s.share, s.rel))
	if s.saved != s.version || s.diskText != "draft" || s.diskConflict {
		t.Fatal("identical external save was treated as conflict")
	}
}

func TestDiskDiffSurvivesJSONForUnicode(t *testing.T) {
	for _, pair := range [][2]string{{"😀x", "😁x"}, {"x😀", "x😈"}, {"😀", "🌀"}, {"a\n", ""}, {"", "café 😀"}} {
		ops := diskDiff(U16(pair[0]), U16(pair[1]))
		data, err := json.Marshal(ops)
		if err != nil {
			t.Fatal(err)
		}
		var raw any
		if err = json.Unmarshal(data, &raw); err != nil {
			t.Fatal(err)
		}
		decoded, ok := Parse(raw)
		if !ok {
			t.Fatal("invalid OT JSON")
		}
		got, err := Apply(U16(pair[0]), decoded)
		if err != nil || Str(got) != pair[1] {
			t.Fatalf("Unicode disk edit corrupted: %s", data)
		}
	}
}
