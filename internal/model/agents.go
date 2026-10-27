package model

import (
	"strings"

	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/util"
)

// Agent one implementation that asks the mesh's models: a model is assigned
// to any number of them, each asking by the name agent-<id>
type Agent struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	About string `json:"about"`
	// Parent the agent whose assignment this one follows while unset
	Parent string `json:"parent,omitempty"`
	// Fast an agent with a second, small model for its background work
	Fast bool `json:"fast,omitempty"`
	// Tier what its model is while unassigned: "small" the smallest ready model, "large" the biggest
	Tier string `json:"tier"`
}

// Agents every implementation that asks a model, in the pages' order
var Agents = []Agent{
	{ID: "code", Label: "Code app", About: "the projects' agent sessions, the default for every harness below", Tier: "large", Fast: true},
	{ID: "claude-code", Label: "Claude Code", About: "Claude Code in a project, on the mesh's models", Parent: "code", Tier: "large", Fast: true},
	{ID: "opencode", Label: "OpenCode", About: "opencode in a project, on the mesh's models", Parent: "code", Tier: "large", Fast: true},
}

// slots an agent's assignments: its model, and for some a fast one
var slots = []string{"model", "fast"}

const agentPrefix = "agent-"

func agentFile(id string) string { return "etc/model/agents/" + id + ".json" }

// AgentByID the agent named, nil for none
func AgentByID(id string) *Agent {
	for i := range Agents {
		if Agents[i].ID == id {
			return &Agents[i]
		}
	}
	return nil
}

// AgentName the name an agent asks the gateway by: agent-<id>, agent-<id>-fast
func AgentName(id string, fast bool) string {
	if fast {
		return agentPrefix + id + "-fast"
	}
	return agentPrefix + id
}

// agentOf the agent and slot a gateway name stands for
func agentOf(m string) (*Agent, string) {
	id, ok := strings.CutPrefix(m, agentPrefix)
	if !ok {
		return nil, ""
	}
	slot := "model"
	if base, f := strings.CutSuffix(id, "-fast"); f {
		id, slot = base, "fast"
	}
	a := AgentByID(id)
	if a == nil || slot == "fast" && !a.Fast {
		return nil, ""
	}
	return a, slot
}

// own an agent's slot as picked for it, "" for none
func own(a *Agent, slot string) string {
	var c map[string]string
	if !sysfs.ReadInto(agentFile(a.ID), &c) {
		return ""
	}
	// a model picked on a host since gone is kept; a non-mesh value never is
	if meshHost(c[slot]) == "" {
		return ""
	}
	return c[slot]
}

// assigned an agent's slot as it asks: its own pick, else its parent's
func assigned(a *Agent, slot string) (pick string, inherited bool) {
	if v := own(a, slot); v != "" {
		return v, false
	}
	if a.Parent != "" {
		if p := AgentByID(a.Parent); p != nil {
			if v := own(p, slot); v != "" {
				return v, true
			}
		}
	}
	return "", false
}

func tierOf(a *Agent, slot string) string {
	if slot == "fast" {
		return "small"
	}
	return a.Tier
}

// Assign a model to an agent's slot, mesh-wide; blank for the automatic pick
func Assign(p map[string]any) (int, any) {
	a := AgentByID(util.Str(p["agent"]))
	if a == nil {
		ids := []string{}
		for _, x := range Agents {
			ids = append(ids, x.ID)
		}
		return 400, map[string]any{"error": "agent is " + strings.Join(ids, ", ")}
	}
	slot := util.Str(p["slot"])
	if slot == "" {
		slot = "model"
	}
	if slot != "model" && (slot != "fast" || !a.Fast) {
		return 400, map[string]any{"error": a.Label + " has no " + slot + " slot"}
	}
	m := strings.TrimSpace(util.Str(p["model"]))
	if m != "" && !strings.Contains(m, "/") {
		m = Mesh + "/" + m
	}
	if m != "" && meshHost(m) == "" {
		return 400, map[string]any{"error": "model is a mesh host running one, as " + Mesh + "/<host>, blank for the automatic pick"}
	}
	if h := meshHost(m); h != "" {
		found := false
		for _, s := range runners(view()) {
			found = found || s["host"] == h
		}
		if !found {
			return 409, map[string]any{"error": h + " runs no model"}
		}
	}
	c := map[string]string{}
	sysfs.ReadInto(agentFile(a.ID), &c)
	if m == "" {
		delete(c, slot)
	} else {
		c[slot] = m
	}
	sysfs.Write(agentFile(a.ID), c)
	return 200, map[string]any{"agent": a.ID, "slot": slot, "model": m}
}

// agentRows each agent with its slots: what was picked, what it answers with, why not
func agentRows(states []map[string]any) []any {
	out := []any{}
	for i := range Agents {
		a := &Agents[i]
		sl := map[string]any{}
		for _, slot := range slots {
			if slot == "fast" && !a.Fast {
				continue
			}
			pref, inherited := assigned(a, slot)
			m, s := resolve(states, tierOf(a, slot), pref)
			host := ""
			if s != nil {
				host = util.JSString(s["host"])
			}
			ready := m != "" && s != nil && s["server"] == "ready"
			why := ""
			if !ready {
				why = excuse(states, s)
			}
			sl[slot] = map[string]any{"chosen": own(a, slot), "inherited": inherited, "assigned": pref, "model": m, "host": host, "ready": ready, "why": why}
		}
		out = append(out, map[string]any{"id": a.ID, "label": a.Label, "about": a.About, "parent": a.Parent, "fast": a.Fast, "slots": sl})
	}
	return out
}

// agentsOn the ids of the agents asking host's model, in any slot
func agentsOn(rows []any, host string) []string {
	out := []string{}
	for _, r := range rows {
		x := util.Obj(r)
		for _, s := range util.Obj(x["slots"]) {
			if util.Obj(s)["host"] == host && util.Truthy(util.Obj(s)["ready"]) {
				out = append(out, util.Str(x["id"]))
				break
			}
		}
	}
	return out
}
