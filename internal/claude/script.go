package claude

// what runs on the host: a setup script fed to sh -s (the skill, mcp.json),
// then claude itself under sh -c, its secrets read off stdin before claude
// takes it over, never in argv or on disk

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"

	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	// configDir claude's own config on the host, apart from the user's
	configDir = `"$HOME/.phosphorus/claude"`
	// pathPrefix where claude's installers put it, ahead of a non-login PATH
	pathPrefix = `PATH="$HOME/.local/bin:$HOME/.claude/local:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; `
	// keyVar the env var mcp.json's header reads the key from
	keyVar = "PHOSPHORUS_MCP_KEY"
)

var (
	skillPathRe = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)
	envNameRe   = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)
)

// Mesh the models served by the mesh, the rest Anthropic's
var Mesh = []string{"chimp", "orangutan"}

// Anthropic the models on the user's own subscription, claude's aliases
var Anthropic = []string{"opus", "sonnet", "haiku"}

// Perms the permission modes the page offers
var Perms = []string{"default", "acceptEdits", "plan", "bypassPermissions"}

func has(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// provider "mesh" or "anthropic", "" for no such model
func provider(m string) string {
	switch {
	case has(Mesh, m):
		return "mesh"
	case has(Anthropic, m):
		return "anthropic"
	}
	return ""
}

// quote a word for sh, single quoted
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// Quote a word for sh, as the launch scripts quote theirs
func Quote(s string) string { return quote(s) }

// shDir a folder as sh reads it, ~ its home
func shDir(d string) string {
	d = strings.TrimSpace(d)
	switch {
	case d == "" || d == "~":
		return `"$HOME"`
	case strings.HasPrefix(d, "~/"):
		return `"$HOME"/` + quote(d[2:])
	}
	return quote(d)
}

// Creds what one start needs of its user, gathered while they're logged in
type Creds struct {
	// User, Pass the host login
	User, Pass string
	// Key the user's mcp key: the mesh models' token, mcp.json's bearer
	Key string
	// Token the Anthropic subscription token, anthropic models only
	Token string
	// Base the mesh's frontend as the host reaches it, http://ip:port
	Base string
	// Skill the phosphorus skill's zip
	Skill []byte
}

// envLines the env claude starts with, a line each: NAME=value
func envLines(model string, c Creds) ([]string, error) {
	env := [][2]string{{keyVar, c.Key}}
	switch provider(model) {
	case "mesh":
		env = append(env, [][2]string{
			{"ANTHROPIC_BASE_URL", c.Base + "/api/model"}, {"ANTHROPIC_AUTH_TOKEN", c.Key},
			{"ANTHROPIC_MODEL", model}, {"ANTHROPIC_SMALL_FAST_MODEL", "chimp"},
			{"ANTHROPIC_DEFAULT_HAIKU_MODEL", "chimp"}, {"ANTHROPIC_DEFAULT_SONNET_MODEL", "orangutan"},
			{"ANTHROPIC_DEFAULT_OPUS_MODEL", "orangutan"}, {"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"},
			{"API_TIMEOUT_MS", "3600000"}}...)
	case "anthropic":
		if c.Token == "" {
			return nil, errors.New("no Anthropic token saved: paste one from claude setup-token in settings")
		}
		env = append(env, [2]string{"CLAUDE_CODE_OAUTH_TOKEN", c.Token})
	default:
		return nil, fmt.Errorf("no model %s", util.JSString(model))
	}
	out := []string{}
	for _, e := range env {
		if !envNameRe.MatchString(e[0]) || e[1] == "" || strings.ContainsAny(e[1], "\r\n\x00") {
			return nil, fmt.Errorf("%s is missing or holds a line break", e[0])
		}
		out = append(out, e[0]+"="+e[1])
	}
	return out, nil
}

// envBlock the env lines as fed to the launch script, a blank line ending them
func envBlock(lines []string) string { return strings.Join(lines, "\n") + "\n\n" }

// launchCommand claude in dir, its env read off stdin first; sh -c so any
// login shell runs it the same
func launchCommand(dir, model, perm, resume string) string {
	args := []string{"claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--include-partial-messages", "--model", model, "--permission-prompt-tool", "stdio",
		"--mcp-config", `"$CLAUDE_CONFIG_DIR/mcp.json"`, "--strict-mcp-config", "--allowedTools", "mcp__phosphorus"}
	if perm != "" && perm != "default" {
		args = append(args, "--permission-mode", perm)
	}
	if resume != "" {
		args = append(args, "--resume", quote(resume))
	}
	script := pathPrefix +
		"unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL CLAUDE_CODE_OAUTH_TOKEN; " +
		`while IFS= read -r l && [ -n "$l" ]; do export "$l"; done; ` +
		"CLAUDE_CONFIG_DIR=" + configDir + "; export CLAUDE_CONFIG_DIR; " +
		"cd " + shDir(dir) + " || exit 3; " +
		"command -v claude >/dev/null 2>&1 || exit 127; " +
		"exec " + strings.Join(args, " ")
	return "sh -c " + quote(script)
}

// mcpConfig phosphorus's server for claude, the key read from the env
func mcpConfig(base string) string {
	return string(util.Marshal(map[string]any{"mcpServers": map[string]any{"phosphorus": map[string]any{
		"type": "http", "url": base + "/api/mcp",
		"headers": map[string]any{"Authorization": "Bearer ${" + keyVar + "}", "X-Phosphorus-Via": "claude-code"}}}}))
}

// setupScript for sh -s: claude's config dir, mcp.json and the skill fresh,
// whatever was there of the skill before gone
func setupScript(skill []byte, base string) (string, error) {
	files := map[string]string{}
	if len(skill) > 0 {
		z, err := zip.NewReader(bytes.NewReader(skill), int64(len(skill)))
		if err != nil {
			return "", err
		}
		for _, f := range z.File {
			if f.FileInfo().IsDir() {
				continue
			}
			if !skillPathRe.MatchString(f.Name) || strings.Contains(f.Name, "..") {
				return "", fmt.Errorf("bad skill file %s", f.Name)
			}
			rc, err := f.Open()
			if err != nil {
				return "", err
			}
			b, err := io.ReadAll(rc)
			rc.Close()
			if err != nil {
				return "", err
			}
			files["skills/"+f.Name] = string(b)
		}
	}
	files["mcp.json"] = mcpConfig(base)
	var s strings.Builder
	s.WriteString("set -e\numask 077\nD=" + configDir + "\nmkdir -p \"$D\"\nrm -rf \"$D/skills/phosphorus\"\n")
	names := []string{}
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		body := files[n]
		if strings.ContainsRune(body, 0) {
			return "", fmt.Errorf("%s isn't text", n)
		}
		if !strings.HasSuffix(body, "\n") {
			body += "\n"
		}
		eof := "PHOS_EOF_" + randHex(8)
		for strings.Contains(body, eof) {
			eof = "PHOS_EOF_" + randHex(8)
		}
		if i := strings.LastIndex(n, "/"); i > 0 {
			fmt.Fprintf(&s, "mkdir -p \"$D\"/%s\n", quote(n[:i]))
		}
		fmt.Fprintf(&s, "cat > \"$D\"/%s <<'%s'\n%s%s\n", quote(n), eof, body, eof)
	}
	s.WriteString(pathPrefix + "\ncommand -v claude >/dev/null 2>&1 || exit 127\n")
	return s.String(), nil
}

// versionCommand claude's version, exit 127 when it isn't there
func versionCommand() string {
	return "sh -c " + quote(pathPrefix+"command -v claude >/dev/null 2>&1 || exit 127; claude --version")
}

// installCommand the official installer, as the login
func installCommand() string {
	return "sh -c " + quote(pathPrefix+"curl -fsSL https://claude.ai/install.sh | bash 2>&1")
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
