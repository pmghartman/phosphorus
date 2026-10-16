package host

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGitLayout(t *testing.T) {
	home = t.TempDir()
	os.MkdirAll(at("git", "data", "conf"), 0o755)
	os.WriteFile(at("git", "data", "GIT_VERSION"), []byte("1 2\n"), 0o644)
	if why := gitLeftovers(); why != "" {
		t.Fatal(why)
	}
	if err := gitUp(); err != nil {
		t.Fatal(err)
	}
	if !fileExists(at("git", "conf")) || fileExists(at("git", "data")) || fileExists(at("git.native")) {
		t.Fatal("git/data not moved up whole")
	}
	gitDown()
	if !fileExists(at("git", "data", "GIT_VERSION")) || fileExists(at("git", "conf")) {
		t.Fatal("rollback didn't restore git/data")
	}
	// a leftover beside data/ refused before anything moves
	os.MkdirAll(at("git", "conf"), 0o755)
	if gitLeftovers() == "" {
		t.Fatal("leftover not caught")
	}
	os.RemoveAll(at("git", "conf"))
	// a run cut short after the first rename, finished by the next
	os.Rename(at("git", "data"), at("git.native"))
	os.Remove(at("git"))
	if err := gitUp(); err != nil || !fileExists(filepath.Join(at("git"), "GIT_VERSION")) {
		t.Fatal("interrupted move not finished", err)
	}
}
