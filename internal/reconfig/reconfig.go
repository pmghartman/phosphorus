// Package reconfig: phosphorus.ini's [files], [home], [git] host and [model]
// host and gpu applied as soon as edited, a rebuild
package reconfig

import (
	"bytes"
	"context"
	"log"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/clock"
	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	appliedFile = filepath.Join(util.StateDir, "reconfig.json")
	// the image's binary, or natively the home's, run against the install
	rebuildCmd = util.Env("REBUILD_CMD", filepath.Join(util.RepoDir, "bin", "phosphorus"))
)

const (
	rebuildTimeout = 20 * time.Minute
	settleMS       = 2000
)

type sig struct {
	Dir   string `json:"dir"`
	Priv  string `json:"priv"`
	Home  string `json:"home"`
	Git   bool   `json:"git"`
	GPU   bool   `json:"gpu"`
	Model bool   `json:"model"`
}

// Current the signature JS wrote, the same bytes
func Current() string {
	return string(util.Marshal(sig{
		Dir: util.Ini("files", "dir"), Priv: util.Ini("files", "priv"), Home: util.Ini("home", "dir"),
		Git: util.Ini("git", "host") == "true", GPU: util.Ini("model", "gpu") == "true", Model: util.Ini("model", "host") == "true",
	}))
}

func applied() string {
	var a struct {
		Sig string `json:"sig"`
	}
	util.ReadJSON(appliedFile, &a)
	return a.Sig
}

// Start the watcher, busy an update's own rebuild under way
func Start(busy func() bool) {
	var a map[string]any
	if !util.ReadJSON(appliedFile, &a) || a == nil {
		util.WriteJSONAtomic(appliedFile, map[string]string{"sig": Current()})
	}
	go func() {
		seen := ""
		var since int64
		for {
			time.Sleep(time.Duration(clock.IdleMS) * time.Millisecond)
			s := Current()
			if s != seen {
				seen = s
				since = util.Now()
				continue
			}
			if s == applied() || util.Now()-since < settleMS || busy() {
				continue
			}
			util.WriteJSONAtomic(appliedFile, map[string]string{"sig": s})
			log.Print("[reconfig] phosphorus.ini [files], [home], [git] or [model] host or gpu changed, rebuilding")
			ctx, cancel := context.WithTimeout(context.Background(), rebuildTimeout)
			var out, errb bytes.Buffer
			cmd := exec.CommandContext(ctx, rebuildCmd, "rebuild", "--home", util.RepoDir)
			cmd.Stdout, cmd.Stderr = &out, &errb
			err := cmd.Run()
			cancel()
			last := func(s string) string {
				l := strings.Split(strings.TrimSpace(s), "\n")
				return l[len(l)-1]
			}
			if err != nil {
				e := errb.String()
				if e == "" {
					e = err.Error()
				}
				log.Printf("[reconfig] rebuild failed: %s", last(e))
			} else if o := last(out.String()); o != "" {
				log.Printf("[reconfig] %s", o)
			}
		}
	}()
}
