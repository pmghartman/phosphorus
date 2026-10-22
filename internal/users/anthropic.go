package users

// a user's own Anthropic subscription token (claude setup-token's), kept in
// their vault under their password: only a request carrying their login
// opens it; and what a Code session needs of a logged in user: a host
// login, their mcp key, all from that same vault

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"

	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/util"
)

const maxToken = 512

var tokenRe = regexp.MustCompile(`^[A-Za-z0-9_.:+/=-]+$`)

// cleanToken a token as kept, "" for none or a bad one
func cleanToken(v any) string {
	t := strings.TrimSpace(str(v))
	if len(t) > maxToken || !tokenRe.MatchString(t) {
		return ""
	}
	return t
}

// DropOldTokens the tokens older releases sealed with the mesh key, gone
func DropOldTokens() {
	for _, f := range sysfs.List("home") {
		if strings.Count(f, "/") == 1 && strings.HasSuffix(f, "/anthropic.json") {
			sysfs.Remove("home/" + f)
		}
	}
}

// dropOnce the old tokens gone on the first read too, any synced in late
var dropOnce = sync.OnceFunc(DropOldTokens)

// SetAnthropic the token sealed in the vault, "" clearing it
func SetAnthropic(s *Session, p map[string]any) R {
	if s == nil || s.Boot || len(s.Key) == 0 {
		return errR(403, "log in as a user")
	}
	dropOnce()
	t := strings.TrimSpace(str(p["token"]))
	if t != "" && cleanToken(t) == "" {
		return errR(400, "that isn't a token: run claude setup-token and paste what it prints")
	}
	v, ok := openVault(s)
	if !ok {
		pull()
		if v, ok = openVault(s); !ok {
			return errR(503, "this host hasn't your saved logins yet, try again shortly")
		}
	}
	cv := cleanVault(v)
	delete(cv, "anthropic")
	if t != "" {
		cv["anthropic"] = t
	}
	text := string(util.Marshal(cv))
	if len(text) > maxVault {
		return errR(413, "too many saved logins")
	}
	sysfs.Write(vaultFile(s.User), Seal(s.Key, text))
	return R{Status: 200, Body: map[string]any{"anthropic": t != ""}}
}

// AnthropicToken the session's user's token, "" for none
func AnthropicToken(s *Session) string {
	dropOnce()
	v, _ := vaultOf(s)
	t, _ := cleanVault(v)["anthropic"].(string)
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

// PageLogin the session's saved page login named name, else the first whose
// url holds urlHas: a service's own login, as Forgejo's
func PageLogin(s *Session, name, urlHas string) (user, pass string, ok bool) {
	v, _ := vaultOf(s)
	ps, _ := cleanVault(v)["pages"].(map[string]any)
	l, _ := ps[name].(map[string]any)
	if u, _ := l["user"].(string); u == "" && urlHas != "" {
		for _, x := range ps {
			p, _ := x.(map[string]any)
			if u, _ := p["user"].(string); u != "" && strings.Contains(fmt.Sprint(p["url"]), urlHas) {
				l = p
				break
			}
		}
	}
	user, _ = l["user"].(string)
	pass, _ = l["pass"].(string)
	return user, pass, user != ""
}

// VaultOK whether this host could open the session's vault
func VaultOK(s *Session) bool {
	_, ok := vaultOf(s)
	return ok
}

// KeyOf the session's user's mcp key: the one in use, a fresh one when
// there's none or it can't be opened, as MCPURL
func KeyOf(s *Session, r *http.Request) (string, bool) {
	o := MCPURL(s, nil, r)
	b, _ := o.Body.(map[string]any)
	k, _ := b["key"].(string)
	return k, o.Status == 200 && k != ""
}
