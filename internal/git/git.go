// Package git: this host's vote in the git master election and the git card
package git

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/elector"
	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	selfHost    = os.Getenv("SELF_HOST")
	stateDir    = util.StateDir
	claimFile   = filepath.Join(stateDir, "git-claim.json")
	rosterFile  = filepath.Join(stateDir, "git-roster.json")
	handoffFile = filepath.Join(stateDir, "git-handoff.json")
	forceFile   = filepath.Join(stateDir, "git-force-promote")
	nameRe      = regexp.MustCompile(`^[A-Za-z0-9-]{1,63}$`)
	started     = time.Now()
)

const (
	leaseCapMS    = 10000
	claimMaxAgeMS = 3000
	settleMS      = 30000
)

var (
	mu       sync.Mutex
	holder   string
	until    time.Time
	roster   elector.Roster
	updating = func() bool { return false }
	bootID   string
)

// Init with server's updating flag and boot id
func Init(isUpdating func() bool, boot string) {
	updating = isUpdating
	bootID = boot
	roster = elector.Roster{Members: []elector.Member{}}
	var saved any
	if util.ReadJSON(rosterFile, &saved) {
		if r := elector.ValidRoster(saved); r != nil {
			roster = *r
		}
	}
}

func isGitHost() bool { return util.Ini("git", "host") == "true" }

// Vote a monotonic lease, the newest roster kept
func Vote(p map[string]any) (int, any) {
	r := elector.ValidRoster(p["roster"])
	c, _ := p["c"].(string)
	msf, ok := p["ms"].(float64)
	if !nameRe.MatchString(c) || !ok || msf != float64(int64(msf)) || msf < 0 || msf > leaseCapMS || r == nil {
		return 400, map[string]any{"error": "bad c, ms or roster"}
	}
	mu.Lock()
	defer mu.Unlock()
	if r.Epoch < roster.Epoch {
		return 200, map[string]any{"granted": false, "roster": roster}
	}
	if r.Epoch > roster.Epoch {
		roster = *r
		util.WriteJSONAtomic(rosterFile, roster)
	}
	if time.Since(started) < leaseCapMS*time.Millisecond {
		return 200, map[string]any{"granted": false, "abstaining": true, "roster": roster}
	}
	now := time.Now()
	if holder != "" && holder != c && now.Before(until) {
		return 200, map[string]any{"granted": false, "holder": holder, "roster": roster}
	}
	if msf == 0 {
		holder, until = "", time.Time{}
	} else {
		holder, until = c, now.Add(time.Duration(msf)*time.Millisecond)
	}
	return 200, map[string]any{"granted": msf > 0, "roster": roster}
}

func claim() any {
	raw := util.ReadFresh(claimFile, claimMaxAgeMS*time.Millisecond)
	if raw == nil {
		return nil
	}
	return util.Decode(raw)
}

// State this host's, published in the mesh snapshot
func State() map[string]any {
	mu.Lock()
	r := roster
	mu.Unlock()
	return map[string]any{"host": selfHost, "gitHost": isGitHost(), "roster": r, "claim": claim(), "updating": updating(), "bootId": bootID}
}

// View ours and every answering peer's, for the elector
func View() []any { return append([]any{State()}, mesh.PeerGit()...) }

// Row one git host on the card
type Row map[string]any

// RowsFp the rows that moved, ageSec ticking left out
func RowsFp(rows []Row) string {
	out := []any{}
	for _, h := range rows {
		out = append(out, []any{h["host"], h["reachable"], h["role"], h["master"], h["gen"], h["eligible"], h["updating"]})
	}
	return string(util.Marshal(out))
}

// Rows ours and every peer's git state, sorted by host
func Rows() []Row {
	now := util.Now() / 1000
	out := map[string]Row{}
	order := []string{}
	set := func(h string, r Row) {
		if _, ok := out[h]; !ok {
			order = append(order, h)
		}
		out[h] = r
	}
	mu.Lock()
	for _, m := range roster.Members {
		if m.Git {
			set(m.Name, Row{"host": m.Name, "reachable": false})
		}
	}
	mu.Unlock()
	for _, s := range View() {
		sm := util.Obj(s)
		h, _ := sm["host"].(string)
		if sm == nil || !nameRe.MatchString(h) {
			continue
		}
		if !(util.Truthy(sm["gitHost"]) || util.Truthy(sm["claim"])) {
			delete(out, h)
			continue
		}
		c := util.Obj(sm["claim"])
		if c == nil {
			c = map[string]any{}
		}
		role := util.Str(c["role"])
		if role == "" {
			role = "starting"
		}
		var gen any = c["gen"]
		if gen == nil {
			gen = nil
		}
		var age any
		if st, ok := c["stamp"].(float64); ok && st != 0 {
			a := float64(now) - st
			if a < 0 {
				a = 0
			}
			age = a
		}
		set(h, Row{"host": h, "reachable": true, "role": role, "master": util.Str(c["master"]), "gen": gen, "ageSec": age,
			"eligible": util.Truthy(c["eligible"]), "updating": util.Truthy(sm["updating"]), "handoffTo": util.Str(c["handoffTo"])})
	}
	rows := []Row{}
	for _, h := range order {
		if r, ok := out[h]; ok {
			rows = append(rows, r)
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		return util.LocaleCompare(rows[i]["host"].(string), rows[j]["host"].(string)) < 0
	})
	return rows
}

// Promote the peer end of make master
func Promote(body map[string]any) (int, any) {
	switch body["op"] {
	case "handoff":
		c := util.Obj(claim())
		if c == nil || c["role"] != "master" {
			return 409, map[string]any{"error": selfHost + " isn't the git master"}
		}
		to, _ := body["to"].(string)
		if !nameRe.MatchString(to) {
			return 400, map[string]any{"error": "bad target"}
		}
		util.WriteJSONAtomic(handoffFile, map[string]any{"to": to, "at": util.Now()})
		return 200, map[string]any{"ok": true}
	case "take":
		if !isGitHost() {
			return 409, map[string]any{"error": selfHost + " isn't a git host"}
		}
		os.WriteFile(forceFile, nil, 0o644)
		return 200, map[string]any{"ok": true}
	}
	return 400, map[string]any{"error": "op must be handoff or take"}
}

func hop(host string, body map[string]any) (int, any) {
	if host != selfHost {
		return util.PeerCall(host, util.Req{Host: host, Method: "POST", Path: "/api/git/promote", Body: body, Timeout: 5 * time.Second, ConnectTimeout: 1500 * time.Millisecond})
	}
	return Promote(body)
}

var inFlight *struct {
	to    string
	until int64
}

func leads(host string) bool {
	for _, h := range Rows() {
		if h["host"] == host && h["reachable"] == true && h["role"] == "master" {
			return true
		}
	}
	return false
}

// Force with a live master a hand-off, without one a force-promote
func Force(target string) (int, any) {
	all := Rows()
	find := func(f func(Row) bool) Row {
		for _, h := range all {
			if f(h) {
				return h
			}
		}
		return nil
	}
	t := find(func(h Row) bool { return h["host"] == target })
	if t == nil || t["reachable"] != true {
		return 409, map[string]any{"error": target + " isn't a reachable git host"}
	}
	if t["role"] == "master" {
		return 409, map[string]any{"error": target + " is already master"}
	}
	if m := find(func(h Row) bool { return h["reachable"] == true && util.Truthy(h["handoffTo"]) }); m != nil {
		return 409, map[string]any{"error": fmt.Sprintf("%s is already handing off to %s", m["host"], m["handoffTo"])}
	}
	if inFlight != nil && util.Now() < inFlight.until && !leads(inFlight.to) {
		return 409, map[string]any{"error": "making " + inFlight.to + " master is already under way"}
	}
	master := find(func(h Row) bool { return h["role"] == "master" && h["reachable"] == true })
	if master == nil && find(func(h Row) bool { return h["reachable"] == true && h["role"] == "starting" }) != nil {
		return 409, map[string]any{"error": "a git host is still starting, try once it settles"}
	}
	if master != nil && (!util.Truthy(t["eligible"]) || t["master"] != master["host"]) {
		return 409, map[string]any{"error": fmt.Sprintf("%s isn't in sync with %s yet", target, master["host"])}
	}
	var st int
	var out any
	if master != nil {
		st, out = hop(master["host"].(string), map[string]any{"op": "handoff", "to": target})
	} else {
		st, out = hop(target, map[string]any{"op": "take"})
	}
	if st == 200 {
		inFlight = &struct {
			to    string
			until int64
		}{target, util.Now() + settleMS}
	}
	return st, out
}

// MakeMaster done only once the target leads
func MakeMaster(target string) (int, any) {
	if leads(target) {
		return 200, map[string]any{"master": target, "note": "already master"}
	}
	start := util.Now()
	st, out := Force(target)
	if st != 200 && !(inFlight != nil && inFlight.to == target) {
		return st, out
	}
	for util.Now()-start < settleMS {
		if leads(target) {
			return 200, map[string]any{"master": target, "tookS": (util.Now() - start + 500) / 1000}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return 504, map[string]any{"error": fmt.Sprintf("%s didn't take over in %ds, the git tool shows where it stands", target, settleMS/1000)}
}

var _ = json.Marshal
