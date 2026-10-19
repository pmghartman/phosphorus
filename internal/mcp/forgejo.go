package mcp

// forgejo as the key's user: its api with the page login saved for git, and
// that login handed to git over https on a host

import (
	"encoding/base64"
	"regexp"
	"strings"

	"github.com/pmghartman/phosphorus/internal/util"
)

// gitService the mesh's forgejo route and its page login's name
const gitService = "git"

var domainRe = regexp.MustCompile(`^[a-z0-9.-]{1,253}$`)

// forgejoLogin the key's page login for forgejo: the one named git, else one
// saved for git.<domain>
func forgejoLogin(c *Caller) (user, pass string, err error) {
	if c == nil || c.Pages == nil {
		return "", "", errc("forbidden", "on a user's key only")
	}
	pages := c.Pages()
	l := util.Obj(pages[gitService])
	if str(l["user"]) == "" && src.Domain() != "" {
		at := "//" + gitService + "." + src.Domain()
		for _, v := range pages {
			if p := util.Obj(v); str(p["user"]) != "" && strings.Contains(str(p["url"]), at) {
				l = p
				break
			}
		}
	}
	if str(l["user"]) == "" {
		return "", "", errc("forbidden", "your key carries no forgejo login: save it in the browser's profile as the page login %s, the key picks it up", gitService)
	}
	return str(l["user"]), str(l["pass"]), nil
}

// gitCreds a posix shell prefix reading the forgejo login off stdin, git
// handed it for https://git.<domain> alone, and the stdin lines it reads
func gitCreds(c *Caller) (prefix, stdin string, err error) {
	user, pass, err := forgejoLogin(c)
	if err != nil {
		return "", "", err
	}
	d := src.Domain()
	if !domainRe.MatchString(d) {
		return "", "", errc("unreachable", "the mesh has no domain, so no forgejo")
	}
	if strings.ContainsAny(user+pass, "\r\n") {
		return "", "", errc("bad_input", "the saved forgejo login holds a line break")
	}
	prefix = "IFS= read -r PHOS_GIT_USER; IFS= read -r PHOS_GIT_PASS; " +
		"export PHOS_GIT_USER PHOS_GIT_PASS GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 " +
		"GIT_CONFIG_KEY_0='credential.https://" + gitService + "." + d + ".helper' " +
		`GIT_CONFIG_VALUE_0='!f() { test "$1" = get && printf "username=%s\npassword=%s\n" "$PHOS_GIT_USER" "$PHOS_GIT_PASS"; }; f'` + "\n"
	return prefix, user + "\n" + pass + "\n", nil
}

func forgejoTools() []tool {
	return []tool{
		{name: "forgejo", scope: "key", open: true, destructive: true,
			description: "Call the mesh's Forgejo (git) API as you, signed in with the forgejo login saved in your vault (the page login git): " +
				"repos, branches, files, commits, issues, pull requests, reviews, releases, orgs, anything under /api/v1. " +
				"Returns status and the JSON body, up to 512KB. Clone and push with terminal_run's git, the same login, at clone_url's address. " +
				"GET /user says who you are; GET /repos/search?q= finds repos; GET /repos/{owner}/{repo}/contents/{path} reads a file.",
			schema: object(map[string]any{
				"method": map[string]any{"type": "string", "enum": []any{"GET", "POST", "PUT", "PATCH", "DELETE"}, "default": "GET"},
				"path":   map[string]any{"type": "string", "description": "under /api/v1, with any query, e.g. /repos/me/app/issues?state=open"},
				"body":   map[string]any{"description": "the JSON body, an object, an array or JSON as text"}}, "path"),
			run: func(a map[string]any, m Meta) (any, error) {
				user, pass, err := forgejoLogin(m.Caller)
				if err != nil {
					return nil, err
				}
				p := "/" + strings.TrimPrefix(strings.TrimPrefix(str(a["path"]), "/"), "api/v1/")
				if strings.Contains(p, "..") {
					return nil, errc("bad_input", "path holds ..")
				}
				body := ""
				switch b := a["body"].(type) {
				case nil:
				case string:
					body = b
				default:
					body = string(util.Marshal(b))
				}
				method := strings.ToUpper(str(a["method"]))
				if method == "" {
					method = "GET"
				}
				hs := map[string]string{"Accept": "application/json",
					"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))}
				out, err := pressed(src.Actions.Service("", gitService, method, "/api/v1"+p, hs, body))
				if err != nil {
					return nil, err
				}
				r := util.Obj(toAny(out))
				if r != nil && src.Domain() != "" {
					r["clone_url"] = "https://" + gitService + "." + src.Domain() + "/{owner}/{repo}.git"
				}
				if st, _ := r["status"].(int); st == 401 {
					r["note"] = "forgejo refused the saved login " + user + ": fix the page login git in your vault"
				}
				return r, nil
			}},
	}
}
