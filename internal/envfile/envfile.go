// Package envfile: the home's .env, its keys read and written in place, the
// file locked to the system and the account running docker
package envfile

import (
	"os"
	"strings"
)

// Key one .env entry, as the setup forms ask for it
type Key struct {
	Name, Label, Hint string
	// Mesh: copied from a peer when left blank on a host joining a mesh
	Mesh bool
}

// Keys every key phosphorus reads, TS_AUTHKEY the one a new host must bring
var Keys = []Key{
	{"TS_AUTHKEY", "Tailscale auth key", "reusable, expires every 90 days", false},
	{"BASE_DOMAIN", "Domain", "the mesh's domain, services under it", true},
	{"TUNNEL_TOKEN", "Cloudflare tunnel token", "for a replica of the mesh's tunnel", true},
	{"TS_API_KEY", "Tailscale API token", "game split DNS, expires every 90 days", true},
	{"ADMIN_PASS", "Admin password", "setup admin's login, the gate on a mesh update", true},
}

// Read every KEY=value, blank values kept
func Read(file string) map[string]string {
	b, err := os.ReadFile(file)
	if err != nil {
		return map[string]string{}
	}
	return Parse(string(b))
}

// Parse KEY=value lines, comments and blanks skipped, the last one winning
func Parse(text string) map[string]string {
	out := map[string]string{}
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || l[0] == '#' {
			continue
		}
		if k, v, ok := strings.Cut(l, "="); ok {
			out[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return out
}

// Missing the keys a host can't start without: TS_AUTHKEY, the rest a peer's
func Missing(file string) []string {
	v := Read(file)
	out := []string{}
	for _, k := range Keys {
		if !k.Mesh && v[k.Name] == "" {
			out = append(out, k.Name)
		}
	}
	return out
}

// Set the given keys, blanks skipped, every other line kept; written in
// place so its owner, mode and ACL stay
func Set(file string, vals map[string]string) error {
	b, err := os.ReadFile(file)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	lines := []string{}
	if len(b) > 0 {
		lines = strings.Split(strings.TrimRight(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n"), "\n")
	}
	done := map[string]bool{}
	for i, l := range lines {
		k, _, ok := strings.Cut(strings.TrimSpace(l), "=")
		k = strings.TrimSpace(k)
		if !ok || strings.HasPrefix(k, "#") {
			continue
		}
		if v := clean(vals[k]); v != "" {
			if done[k] {
				lines[i] = ""
				continue
			}
			lines[i] = k + "=" + v
			done[k] = true
		}
	}
	for _, k := range Keys {
		if v := clean(vals[k.Name]); v != "" && !done[k.Name] {
			lines = append(lines, k.Name+"="+v)
			done[k.Name] = true
		}
	}
	for k, v := range vals {
		if v = clean(v); v != "" && !done[k] {
			lines = append(lines, k+"="+v)
		}
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = f.WriteString(strings.Join(lines, "\n") + "\n")
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// a pasted key: whitespace, quotes and newlines gone
func clean(v string) string {
	v = strings.Join(strings.Fields(v), "")
	return strings.Trim(v, `"'`)
}

// Ensure the file exists, locked
func Ensure(file string) error {
	if _, err := os.Stat(file); os.IsNotExist(err) {
		if err := os.WriteFile(file, nil, 0o600); err != nil {
			return err
		}
	}
	return Lock(file)
}
