package mcp

// the claude plugin for one user, no key or server in it: the connector they
// already have does the calling; its files with the user filled in, and the tool
// reference drawn from the list that user's key sees

import (
	"archive/zip"
	"bytes"
	"embed"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

//go:embed all:plugin
var pluginFS embed.FS

var semverRe = regexp.MustCompile(`^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$`)

// Plugin the zip for user on the mesh at base, every file under the plugin's root
func Plugin(user string, admin bool, base string) ([]byte, error) {
	toolsOnce.Do(buildOnce)
	ver := strings.TrimPrefix(util.Str(src.Self()["version"]), "v")
	if !semverRe.MatchString(ver) {
		ver = "0.0.0"
	}
	note := ""
	if admin {
		note = " (an admin)"
	}
	r := strings.NewReplacer("{{BASE}}", base, "{{USER}}", user, "{{ADMIN_NOTE}}", note,
		"{{VERSION}}", ver, "{{BUILT}}", time.Now().UTC().Format("2006-01-02"))
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	add := func(name, body string) error {
		f, err := z.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Now()})
		if err != nil {
			return err
		}
		_, err = f.Write([]byte(body))
		return err
	}
	err := fs.WalkDir(pluginFS, "plugin", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := pluginFS.ReadFile(p)
		if err != nil {
			return err
		}
		return add(strings.TrimPrefix(p, "plugin/"), r.Replace(string(b)))
	})
	if err == nil {
		err = add("skills/phosphorus/references/tools.md", toolsDoc(user, admin))
	}
	if err == nil {
		err = z.Close()
	}
	return buf.Bytes(), err
}

// toolsDoc every tool the key sees: what it does, its kind, its arguments
func toolsDoc(user string, admin bool) string {
	var b strings.Builder
	who := "a user's key"
	if admin {
		who = "an admin's key"
	}
	list := toolList(false, &Caller{User: user, Admin: admin})
	fmt.Fprintf(&b, "# Tools\n\nThe %d tools the phosphorus MCP server lists for %s (%s), generated from the server. "+
		"`version` names any tool kept off this list and why. Arguments marked * are required.\n\n", len(list), user, who)
	for _, x := range list {
		t := util.Obj(x)
		fmt.Fprintf(&b, "## %s\n\n_%s_\n\n%s\n\n", util.Str(t["name"]), toolKind(util.Obj(t["annotations"])), util.Str(t["description"]))
		args := argLines(util.Obj(t["inputSchema"]), "")
		if len(args) == 0 {
			b.WriteString("No arguments.\n\n")
			continue
		}
		b.WriteString(strings.Join(args, "\n") + "\n\n")
	}
	return b.String()
}

func toolKind(a map[string]any) string {
	switch {
	case a["readOnlyHint"] == true && a["openWorldHint"] == true:
		return "read only, reaches outside the mesh"
	case a["readOnlyHint"] == true:
		return "read only"
	case a["destructiveHint"] == true:
		return "destructive: the user's word for this target first"
	}
	return "writes"
}

// argLines a schema's properties as a list, objects' own nested under them
func argLines(s map[string]any, indent string) []string {
	props := util.Obj(s["properties"])
	req := map[string]bool{}
	if rs, ok := s["required"].([]string); ok {
		for _, k := range rs {
			req[k] = true
		}
	}
	if rs, ok := s["required"].([]any); ok {
		for _, k := range rs {
			req[util.Str(k)] = true
		}
	}
	keys := make([]string, 0, len(props))
	for k := range props {
		keys = append(keys, k)
	}
	// required first, then by name
	sort.Slice(keys, func(i, j int) bool {
		if req[keys[i]] != req[keys[j]] {
			return req[keys[i]]
		}
		return keys[i] < keys[j]
	})
	var out []string
	for _, k := range keys {
		p := util.Obj(props[k])
		line := indent + "- `" + k + "`"
		if req[k] {
			line += "*"
		}
		if t := util.Str(p["type"]); t != "" {
			line += " " + t
		}
		if e, ok := p["enum"].([]any); ok {
			vs := make([]string, len(e))
			for i, v := range e {
				vs[i] = util.Str(v)
			}
			line += " (" + strings.Join(vs, " | ") + ")"
		}
		if d, ok := p["default"]; ok {
			line += fmt.Sprintf(", default %v", d)
		}
		if d := util.Str(p["description"]); d != "" {
			line += ": " + d
		}
		out = append(out, line)
		if util.Str(p["type"]) == "object" {
			out = append(out, argLines(p, indent+"  ")...)
		}
		if it := util.Obj(p["items"]); util.Str(it["type"]) == "object" {
			out = append(out, argLines(it, indent+"  ")...)
		}
	}
	return out
}
