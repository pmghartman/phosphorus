package files

import "os"

// owner, adopt: Windows' files keep their folder's permissions on their own
type owner struct{ ok bool }

func ownerAt(string) owner      { return owner{} }
func adopt(string, owner)       {}
func mkdirAll(abs string) error { return os.MkdirAll(abs, 0o755) }

// Own a home handed to a login: Windows' homes need no hand-over
func Own(home, login string) (int, any) {
	return 200, map[string]any{"ok": true, "owner": login, "already": true}
}
