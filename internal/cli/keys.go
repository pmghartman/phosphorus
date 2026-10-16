package cli

import (
	"os/exec"
	"strings"

	"github.com/pmghartman/phosphorus/internal/envfile"
	"github.com/pmghartman/phosphorus/internal/util"
)

// the home's .env, phosphorus run passing its path
var envFile = util.Env("PHOSPHORUS_ENV_FILE", "/repo/.env")

const (
	keysNote      = "values never shown, a blank field keeps what's set"
	joinNote      = "joining a mesh: TS_AUTHKEY alone, the rest copied from a peer"
	keysNoteApply = "saving restarts phosphorus with them"
	keysSaved     = "saved, phosphorus restarting with them"
)

// every key blank and masked, the hint saying only whether one is set
func keysForm(first bool) *form {
	have := envfile.Read(envFile)
	fs := []*field{}
	for _, k := range envfile.Keys {
		state := c("offmesh")("not set")
		if have[k.Name] != "" {
			state = c("online")("set")
		}
		fs = append(fs, &field{key: k.Name, hint: state + c("muted")(", "+k.Hint), secret: true})
	}
	title := "keys"
	if first {
		title = "keys, first start"
	}
	return &form{kind: "keys", title: title, fields: fs, first: first}
}

func saveKeys(f *form) string {
	vals := map[string]string{}
	for _, x := range f.fields {
		if v := strings.TrimSpace(x.value); v != "" {
			vals[x.key] = v
		}
	}
	if vals["TS_AUTHKEY"] == "" && envfile.Read(envFile)["TS_AUTHKEY"] == "" {
		return "TS_AUTHKEY is needed, the rest can come from the mesh"
	}
	if len(vals) == 0 {
		if ui.keysOnly {
			return ""
		}
		return "nothing typed, esc closes"
	}
	if err := envfile.Set(envFile, vals); err != nil {
		return "can't write " + envFile + ": " + errText(err)
	}
	return ""
}

// applyKeys phosphorus restarted on the new .env, by the home's own
// rebuild, its own session so quitting the cli never cuts it short
func applyKeys() {
	c := exec.Command(util.Env("REBUILD_CMD", "/usr/local/bin/phosphorus"), "rebuild", "--home", util.RepoDir)
	detach(c)
	if c.Start() == nil {
		go c.Wait()
	}
}

// Keys the key form alone, before phosphorus runs: 0 saved, 1 cancelled
func Keys(file string) int {
	envFile = file
	ui.keysOnly = true
	return run(nil, func() { openForm(keysForm(len(envfile.Missing(file)) > 0)) })
}
