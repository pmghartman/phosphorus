// Package procs: every process with its phosphorus role, on any OS; a role
// from PHOSPHORUS_ROLE where the OS shows another process's env, else the
// nearest ancestor phosphorus run recorded in state/roles.json
package procs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v4/process"

	"github.com/pmghartman/phosphorus/internal/util"
)

// P one process
type P struct {
	PID, PPID int32
	Name, Cmd string
	Role      string
	RSS       uint64
	// CPU seconds since it started, user and system
	CPU float64
}

// RolesFile phosphorus run's own children by pid, STATE_DIR read late: run sets it after start
func RolesFile() string { return filepath.Join(util.Env("STATE_DIR", util.StateDir), "roles.json") }

// WriteRoles the pid of each of run's children and run's own
func WriteRoles(m map[int]string) {
	out := map[string]string{}
	for pid, r := range m {
		out[strconv.Itoa(pid)] = r
	}
	b, _ := json.Marshal(out)
	tmp := RolesFile() + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		os.Rename(tmp, RolesFile())
	}
}

func readRoles() map[int32]string {
	m := map[string]string{}
	b, _ := os.ReadFile(RolesFile())
	json.Unmarshal(b, &m)
	out := map[int32]string{}
	for k, v := range m {
		if n, err := strconv.Atoi(k); err == nil {
			out[int32(n)] = v
		}
	}
	return out
}

func envRole(p *process.Process) string {
	env, err := p.Environ()
	if err != nil {
		return ""
	}
	for _, kv := range env {
		if strings.HasPrefix(kv, "PHOSPHORUS_ROLE=") {
			return strings.TrimPrefix(kv, "PHOSPHORUS_ROLE=")
		}
	}
	return ""
}

// List every process this account can see, roles resolved
func List() []P {
	ps, err := process.Processes()
	if err != nil {
		return nil
	}
	known := readRoles()
	out := make([]P, 0, len(ps))
	byPID := map[int32]*P{}
	for _, p := range ps {
		x := P{PID: p.Pid}
		x.PPID, _ = p.Ppid()
		x.Name, _ = p.Name()
		if c, err := p.Cmdline(); err == nil {
			x.Cmd = c
		}
		if m, err := p.MemoryInfo(); err == nil && m != nil {
			x.RSS = m.RSS
		}
		if t, err := p.Times(); err == nil && t != nil {
			x.CPU = t.User + t.System
		}
		x.Role = envRole(p)
		if x.Role == "" {
			x.Role = known[p.Pid]
		}
		out = append(out, x)
	}
	for i := range out {
		byPID[out[i].PID] = &out[i]
	}
	// unlabelled descendants of a recorded child take its role
	for i := range out {
		if out[i].Role != "" {
			continue
		}
		seen := map[int32]bool{}
		for at := out[i].PPID; at > 1 && !seen[at]; {
			seen[at] = true
			if r := known[at]; r != "" {
				out[i].Role = r
				break
			}
			q := byPID[at]
			if q == nil {
				break
			}
			if q.Role != "" && known[q.PID] == "" {
				out[i].Role = q.Role
				break
			}
			at = q.PPID
		}
	}
	return out
}

// Ours the processes carrying a phosphorus role
func Ours() []P {
	out := []P{}
	for _, p := range List() {
		if p.Role != "" {
			out = append(out, p)
		}
	}
	return out
}
