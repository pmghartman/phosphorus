//go:build !windows

package files

import (
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
)

// owner a file's owner and mode, as it was before a write replaced it
type owner struct {
	uid, gid int
	mode     os.FileMode
	ok       bool
}

func ownerAt(p string) owner {
	st, err := os.Lstat(p)
	if err != nil {
		return owner{}
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return owner{}
	}
	return owner{uid: int(sys.Uid), gid: int(sys.Gid), mode: st.Mode().Perm(), ok: true}
}

// adopt what a write made at p: the file it replaced's owner and mode, else
// its folder's owner. Phosphorus writes as root, so a home handed to its
// user's own login on this machine stays that login's, file by file
func adopt(p string, prev owner) {
	if os.Geteuid() != 0 {
		return
	}
	o := prev
	if !o.ok {
		o = ownerAt(filepath.Dir(p))
		o.mode = 0
	}
	if !o.ok || o.uid == 0 {
		return
	}
	os.Lchown(p, o.uid, o.gid)
	if prev.ok && prev.mode != 0 {
		os.Chmod(p, prev.mode)
	}
}

// mkdirAll as os.MkdirAll, each folder it makes its parent's owner's
func mkdirAll(abs string) error {
	missing := []string{}
	for d := abs; !exists(d); d = filepath.Dir(d) {
		missing = append(missing, d)
		if filepath.Dir(d) == d {
			break
		}
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return err
	}
	for i := len(missing) - 1; i >= 0; i-- {
		adopt(missing[i], owner{})
	}
	return nil
}

// Own a user's home on this machine handed to their own login here, so its
// builds and shells write in it as Phosphorus does: the folder and all in it
func Own(home, login string) (int, any) {
	if os.Geteuid() != 0 {
		return 409, errBody("Phosphorus doesn't run as root here: the home's already as its files' owners left it")
	}
	u, err := user.Lookup(login)
	if err != nil {
		return 404, errBody(login + " isn't an account on this machine")
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	if uid == 0 {
		return 400, errBody("not root's: a home is handed to a person's own login")
	}
	if o := ownerAt(home); o.ok && o.uid == uid {
		return 200, map[string]any{"ok": true, "owner": login, "already": true}
	}
	var bad error
	filepath.Walk(home, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if e := os.Lchown(p, uid, gid); e != nil && bad == nil && !errors.Is(e, os.ErrNotExist) {
			bad = e
		}
		return nil
	})
	if bad != nil {
		return 500, errBody(bad.Error())
	}
	return 200, map[string]any{"ok": true, "owner": login}
}
