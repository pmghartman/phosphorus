package mcp

// what a key may do past its user's name: admin, the hosts it carries a saved
// login for, a forgejo login; its tool list, refusals and instructions follow it

import (
	"fmt"
	"sort"
	"strings"
)

type grants struct {
	admin   bool
	hosts   []string
	forgejo bool
}

// grants the key's, worked out once per request
func (c *Caller) grants() *grants {
	if c.g != nil {
		return c.g
	}
	g := &grants{admin: c.Admin}
	if c.Hosts != nil {
		g.hosts = c.Hosts()
		sort.Strings(g.hosts)
	}
	_, _, err := forgejoLogin(c)
	g.forgejo = err == nil
	c.g = g
	return g
}

// sig the grants as a cache key for the tool list they give
func (g *grants) sig() string {
	return fmt.Sprintf("%t|%t|%s", g.admin, g.forgejo, strings.Join(g.hosts, ","))
}

// withheld why a key's grants keep a tool off its list, "" when they don't
func withheld(t *tool, c *Caller) string {
	g := c.grants()
	switch {
	case t.admin && !g.admin:
		return "admins only"
	case t.name == "forgejo" && !g.forgejo:
		return "needs a forgejo login on the key: save it in the browser's profile as the page login " + gitService + ", then reconnect"
	}
	return ""
}

// keyDescription a tool's description with what this key can do with it
func keyDescription(t *tool, c *Caller) string {
	if t.name != "terminal_run" {
		return t.description
	}
	g := c.grants()
	d := t.description + " This key's saved logins: "
	if len(g.hosts) == 0 {
		d += "none, so only mode tab, in a terminal the person opened and shared."
	} else {
		d += strings.Join(g.hosts, ", ") + "; any other host takes mode tab only."
	}
	if !g.forgejo {
		d += " git is off: the key carries no forgejo login."
	}
	return d
}

// keyNote the key's rights in words, for initialize's instructions
func keyNote(c *Caller) string {
	g := c.grants()
	role := "a user"
	if g.admin {
		role = "an admin"
	}
	var b strings.Builder
	fmt.Fprintf(&b, " This key acts as %s, %s.", c.User, role)
	if len(g.hosts) == 0 {
		b.WriteString(" It carries no saved host logins: terminal_run works only with mode tab, in a terminal the person opened and shared.")
	} else {
		fmt.Fprintf(&b, " Saved host logins: %s, where terminal_run runs over ssh as that login; any other host takes mode tab only.", strings.Join(g.hosts, ", "))
	}
	if g.forgejo {
		b.WriteString(" A forgejo login is saved: forgejo and terminal_run git work as it.")
	} else {
		b.WriteString(" No forgejo login: forgejo and terminal_run git are off.")
	}
	off := []string{}
	for i := range tools {
		t := &tools[i]
		if !t.project && t.scope != "ask" && withheld(t, c) != "" {
			off = append(off, t.name)
		}
	}
	if len(off) > 0 {
		fmt.Fprintf(&b, " Off this key: %s; never offer them, say who could.", strings.Join(off, ", "))
	}
	b.WriteString(" Files follow each share's own r, w and d perms, which files_list shows. Logins saved in the browser reach the key on its next connection.")
	return b.String()
}
