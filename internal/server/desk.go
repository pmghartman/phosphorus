package server

import (
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"

	"github.com/pmghartman/phosphorus/internal/files"
)

// deskStamps each Desktop folder in the home by its path, a hash of its
// entries' names, sizes and times, so browsers reread one only when it changes
func deskStamps() map[string]string {
	out := map[string]string{}
	users, _ := os.ReadDir(files.HomeRoot)
	for _, u := range users {
		if !u.IsDir() {
			continue
		}
		rel := u.Name() + "/" + files.Desktop
		ents, err := os.ReadDir(filepath.Join(files.HomeRoot, u.Name(), files.Desktop))
		if err != nil {
			continue
		}
		h := fnv.New64a()
		for _, e := range ents {
			fi, err := e.Info()
			if err != nil {
				continue
			}
			fmt.Fprintf(h, "%s\x00%d\x00%d\x00%t\x00", e.Name(), fi.Size(), fi.ModTime().UnixNano(), e.IsDir())
		}
		out[rel] = fmt.Sprintf("%x", h.Sum64())
	}
	return out
}
