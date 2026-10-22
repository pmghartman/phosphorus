package users

// a user's own Anthropic subscription token (claude setup-token's), sealed
// with the mesh key as the key's logins are reachable server side: any host
// holding the mesh key can start that user's Code session; and what a Code
// session needs of a logged in user: a host login, their mcp key

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/util"
)

const maxToken = 512

var tokenRe = regexp.MustCompile(`^[A-Za-z0-9_.:+/=-]+$`)

func anthropicFile(n string) string { return "home/" + n + "/anthropic.json" }

type anthropicRec struct {
	T  *Box  `json:"t"`
	At int64 `json:"at"`
}

// SetAnthropic the token sealed, "" clearing it
func SetAnthropic(s *Session, p map[string]any) R {
	if s == nil || s.Boot {
		return errR(403, "log in as a user")
	}
	t := strings.TrimSpace(str(p["token"]))
	if t == "" {
		sysfs.Remove(anthropicFile(s.User))
		return R{Status: 200, Body: map[string]any{"anthropic": false}}
	}
	if len(t) > maxToken || !tokenRe.MatchString(t) {
		return errR(400, "that isn't a token: run claude setup-token and paste what it prints")
	}
	b := Seal(MeshKey(), t)
	sysfs.Write(anthropicFile(s.User), anthropicRec{T: &b, At: util.Now()})
	return R{Status: 200, Body: map[string]any{"anthropic": true}}
}

// HasAnthropic whether the user saved a token this mesh can open
func HasAnthropic(u string) bool { return AnthropicToken(u) != "" }

// AnthropicToken the user's token, "" for none
func AnthropicToken(u string) string {
	var rec anthropicRec
	if !nameRe.MatchString(u) || !sysfs.ReadInto(anthropicFile(u), &rec) || rec.T == nil {
		return ""
	}
	t, ok := Open(MeshKey(), *rec.T)
	if !ok {
		return ""
	}
	return t
}

// HostLogins the hosts the session's user saved a login for, sorted
func HostLogins(s *Session) []string {
	v, _ := vaultOf(s)
	hs, _ := cleanVault(v)["hosts"].(map[string]any)
	return sortedKeys(hs)
}

// HostLogin the session's saved login for host
func HostLogin(s *Session, host string) (user, pass string, ok bool) {
	v, _ := vaultOf(s)
	hs, _ := cleanVault(v)["hosts"].(map[string]any)
	l, _ := hs[host].(map[string]any)
	user, _ = l["user"].(string)
	pass, _ = l["pass"].(string)
	return user, pass, user != ""
}

// KeyOf the session's user's mcp key: the one in use, a fresh one when
// there's none or it can't be opened, as MCPURL
func KeyOf(s *Session, r *http.Request) (string, bool) {
	o := MCPURL(s, nil, r)
	b, _ := o.Body.(map[string]any)
	k, _ := b["key"].(string)
	return k, o.Status == 200 && k != ""
}
