package sysfs

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pmghartman/phosphorus/internal/files"
)

func TestMigrateMovesTheOldFolderOnce(t *testing.T) {
	dir := t.TempDir()
	oldHome, oldRoot := files.HomeRoot, Root
	files.HomeRoot, Root = dir, filepath.Join(dir, files.Sys)
	t.Cleanup(func() { files.HomeRoot, Root = oldHome, oldRoot })
	os.MkdirAll(filepath.Join(dir, "sys", "etc"), 0o755)
	os.WriteFile(filepath.Join(dir, "sys", "etc", "a.json"), []byte("{}"), 0o644)
	migrate()
	if _, err := os.Stat(filepath.Join(Root, "etc", "a.json")); err != nil {
		t.Fatalf("not moved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "sys")); err == nil {
		t.Error("the old folder is still there")
	}
	// a new folder already there is left alone, whatever the old one holds
	os.MkdirAll(filepath.Join(dir, "sys"), 0o755)
	migrate()
	if _, err := os.Stat(filepath.Join(dir, "sys")); err != nil {
		t.Error("the old folder was moved over the new one")
	}
}
