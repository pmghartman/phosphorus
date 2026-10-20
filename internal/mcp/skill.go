package mcp

// the claude skill for one user, uploaded to claude.ai or dropped in a skills
// folder; no key in it, the connector they already have doing the calling: its
// files with the user filled in, the tools' own descriptions their reference

import (
	"archive/zip"
	"bytes"
	"embed"
	"io/fs"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

//go:embed all:skill
var skillFS embed.FS

// Skill the zip for user on the mesh at base: the phosphorus folder at its root
func Skill(user string, admin bool, base string) ([]byte, error) {
	ver := strings.TrimPrefix(util.Str(src.Self()["version"]), "v")
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
	err := fs.WalkDir(skillFS, "skill", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := skillFS.ReadFile(p)
		if err != nil {
			return err
		}
		return add(strings.TrimPrefix(p, "skill/"), r.Replace(string(b)))
	})
	if err == nil {
		err = z.Close()
	}
	return buf.Bytes(), err
}
