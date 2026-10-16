// Package elector: git master election, every host's frontend voting, a
// majority lease making one master, joint rosters keeping quorums
// overlapping, acted on by git-daemon.sh
package elector

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	stateDir      = util.Env("STATE_DIR", "/state")
	frontendPort  = util.EnvInt("FRONTEND_PORT", 8090)
	claimFile     = filepath.Join(stateDir, "git-claim.json")
	rosterFile    = filepath.Join(stateDir, "git-elector-roster.json")
	handoffFile   = filepath.Join(stateDir, "git-handoff.json")
	localFile     = util.Env("LOCAL_FILE", "/run/git-local")
	decisionFile  = util.Env("DECISION_FILE", "/run/git-decision")
	leaseFile     = util.Env("LEASE_UNTIL_FILE", "/run/git-lease-until")
	litefsPidFile = util.Env("LITEFS_PID_FILE", "/run/git-litefs-pid")
	dbPosFile     = util.Env("DB_POS_FILE", "/var/lib/phosphorus/git/litefs/forgejo.db-pos")
	promotingFile = util.Env("PROMOTING_FILE", "/run/git-promoting")

	tickMS        = int64(util.EnvInt("TICK_MS", 500))
	probeTimeout  = time.Duration(util.EnvInt("PROBE_TIMEOUT_MS", 500)) * time.Millisecond
	leaseMS       = int64(util.EnvInt("LEASE_MS", 4000))
	leaseMarginMS = int64(util.EnvInt("LEASE_MARGIN_MS", 1500))
	promoteGrace  = util.EnvInt("PROMOTE_GRACE", 2)
	addAfterMS    = int64(util.EnvInt("ADD_AFTER_MS", 3000))
	removeAfterMS = int64(util.EnvInt("REMOVE_AFTER_MS", 300000))
	holdMS        = int64(util.EnvInt("HOLD_MS", 15000))
	witnessMS     = float64(util.EnvInt("WITNESS_MS", 60000))
	vouchMS       = int64(util.EnvInt("VOUCH_MS", 120000))
)

const handoffMaxAgeMS = 30000

var nameRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,63}$`)

func logf(format string, a ...any) { log.Printf("[elector] "+format, a...) }

// Member of a roster, tb kept absent when a peer sent none
type Member struct {
	Name string `json:"name"`
	Git  bool   `json:"git"`
	TB   *bool  `json:"tb,omitempty"`
}

// Roster prev nil marshals as null
type Roster struct {
	Epoch   int       `json:"epoch"`
	Members []Member  `json:"members"`
	Prev    *[]Member `json:"prev"`
}

func bp(b bool) *bool { return &b }

func (m Member) tb() bool { return m.TB != nil && *m.TB }

func isInt(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return int(f), true
}

func validMembers(v any) ([]Member, bool) {
	arr, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]Member, 0, len(arr))
	for _, x := range arr {
		o, ok := x.(map[string]any)
		if !ok {
			return nil, false
		}
		n, _ := o["name"].(string)
		g, gok := o["git"].(bool)
		if !nameRe.MatchString(n) || !gok {
			return nil, false
		}
		m := Member{Name: n, Git: g}
		if t, has := o["tb"]; has {
			tb, ok := t.(bool)
			if !ok {
				return nil, false
			}
			m.TB = bp(tb)
		}
		out = append(out, m)
	}
	return out, true
}

// ValidRoster from generic JSON, nil when malformed
func ValidRoster(v any) *Roster {
	o, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	ep, ok := isInt(o["epoch"])
	if !ok || ep < 0 {
		return nil
	}
	ms, ok := validMembers(o["members"])
	if !ok {
		return nil
	}
	r := &Roster{Epoch: ep, Members: ms}
	if p, has := o["prev"]; has && p != nil {
		pm, ok := validMembers(p)
		if !ok {
			return nil
		}
		r.Prev = &pm
	} else if !has {
		// prev undefined fails JS's `r.prev !== null` check
		return nil
	}
	return r
}

type claim struct {
	Host      string
	Role      string
	Master    string
	Gen       int
	Stamp     int
	Txid      int
	Eligible  bool
	HandoffTo string
}

func validClaim(v any) *claim {
	o, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	role, _ := o["role"].(string)
	if role != "master" && role != "servant" && role != "none" {
		return nil
	}
	g, ok1 := isInt(o["gen"])
	s, ok2 := isInt(o["stamp"])
	if !ok1 || !ok2 {
		return nil
	}
	c := &claim{Role: role, Gen: g, Stamp: s, Txid: -1}
	c.Master, _ = o["master"].(string)
	if t, ok := isInt(o["txid"]); ok {
		c.Txid = t
	}
	c.Eligible = truthy(o["eligible"])
	c.HandoffTo, _ = o["handoffTo"].(string)
	return c
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case nil:
		return false
	}
	return true
}

func uptimeMS() int64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return time.Now().UnixMilli()
	}
	f, _ := strconv.ParseFloat(strings.Fields(string(b))[0], 64)
	return int64(math.Round(f * 1000))
}

func writeAtomic(file, text string) {
	tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(tmp, []byte(text), 0o644); err == nil {
		os.Rename(tmp, file)
	}
}

func marshal(v any) string { return string(util.Marshal(v)) }

// E the elector's state, one goroutine driving it
type E struct {
	self      string
	known     Roster
	firstSeen map[string]int64
	lastSeen  map[string]int64
	gitFlag   map[string]bool
	claims    map[string]*claim
	selfState map[string]any
	viewOK    bool
	witnessed map[string]bool
	pollMS    int64

	role, master          string
	gen                   int
	leaseUntil            int64
	committed             int
	noMasterTicks, skip   int
	refused               string
	holdUntil             int64
	stopping              atomic.Bool
	handedOffBoot         string
	handoffTo             string
	vouched               bool
	vouchedAt             int64
	dbOK                  bool
	lastMaster, finalFrom string
	lastStall             string
	txid                  atomic.Int64
	posReading            atomic.Bool
	grantedLast           map[string]bool
	client                *http.Client
	mu                    sync.Mutex
}

func emptyRoster() Roster { return Roster{Epoch: 0, Members: []Member{}, Prev: nil} }

func (e *E) stall(why string) {
	if why == e.lastStall {
		return
	}
	e.lastStall = why
	logf("no master, not campaigning: %s", why)
}

func selfAddr(self string) string {
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip != nil && ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127 {
				return ip.String()
			}
		}
	}
	return self
}

// call parsed JSON on a 200, else nil
func (e *E) call(host, method, p string, body any) map[string]any {
	h := host
	if host == e.self {
		h = selfAddr(e.self)
	}
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(util.Marshal(body))
	}
	req, err := http.NewRequest(method, "http://"+net.JoinHostPort(h, strconv.Itoa(frontendPort))+p, rd)
	if err != nil {
		return nil
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := e.client.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil || res.StatusCode != 200 {
		return nil
	}
	var out map[string]any
	if json.Unmarshal(b, &out) != nil {
		return nil
	}
	return out
}

func (e *E) adopt(v any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	r := ValidRoster(v)
	if r == nil || r.Epoch <= e.known.Epoch {
		return
	}
	e.known = *r
	writeAtomic(rosterFile, marshal(e.known))
}

func names(m []Member) []string {
	out := make([]string, len(m))
	for i, x := range m {
		out[i] = x.Name
	}
	return out
}

func gitNames(m []Member) []string {
	out := []string{}
	for _, x := range m {
		if x.Git {
			out = append(out, x.Name)
		}
	}
	sort.Strings(out)
	return out
}

func uniq(xs []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func voters(r Roster) []string {
	all := names(r.Members)
	if r.Prev != nil {
		all = append(all, names(*r.Prev)...)
	}
	return uniq(all)
}

func describe(m []Member) string {
	parts := make([]string, len(m))
	for i, x := range m {
		if x.Git {
			parts[i] = x.Name + "*"
		} else {
			parts[i] = x.Name
		}
	}
	return strings.Join(parts, " ")
}

func tiebreaker(m []Member) string {
	for _, x := range m {
		if x.tb() && x.Git {
			return x.Name
		}
	}
	g := gitNames(m)
	if len(g) > 0 {
		return g[0]
	}
	return ""
}

func partOK(m []Member, granted map[string]bool, leader string) bool {
	gits := gitNames(m)
	if len(gits) == 1 && gits[0] == leader {
		return true
	}
	got := 0
	for _, x := range m {
		if granted[x.Name] {
			got++
		}
	}
	return got*2 > len(m) || (got*2 == len(m) && len(gits) > 0 && granted[tiebreaker(m)])
}

func quorum(r Roster, granted map[string]bool, leader string) bool {
	return partOK(r.Members, granted, leader) && (r.Prev == nil || partOK(*r.Prev, granted, leader))
}

// probe every host's git state as the local frontend's mesh poll carried it
func (e *E) probe() bool {
	now := uptimeMS()
	view := e.call(e.self, "GET", "/api/git/view", nil)
	states, ok := view["states"].([]any)
	e.viewOK = view != nil && ok
	if !e.viewOK {
		return false
	}
	if pm, ok := view["pollMs"].(float64); ok && pm > 0 && !math.IsInf(pm, 0) {
		e.pollMS = int64(pm)
	} else {
		e.pollMS = tickMS
	}
	byHost := map[string]map[string]any{}
	order := []string{}
	for _, s := range states {
		o, ok := s.(map[string]any)
		if !ok {
			continue
		}
		h, _ := o["host"].(string)
		if !nameRe.MatchString(h) {
			continue
		}
		if _, dup := byHost[h]; !dup {
			order = append(order, h)
		}
		byHost[h] = o
	}
	e.claims = map[string]*claim{}
	off, _ := view["offlineMs"].(map[string]any)
	e.witnessed = map[string]bool{}
	for h, v := range off {
		f, ok := v.(float64)
		if nameRe.MatchString(h) && h != e.self && byHost[h] == nil && ok && f >= witnessMS {
			e.witnessed[h] = true
		}
	}
	for h := range e.firstSeen {
		if byHost[h] == nil {
			delete(e.firstSeen, h)
		}
	}
	for _, h := range order {
		s := byHost[h]
		e.adopt(s["roster"])
		e.lastSeen[h] = now
		if _, ok := e.firstSeen[h]; !ok {
			e.firstSeen[h] = now
		}
		gh, _ := s["gitHost"].(bool)
		e.gitFlag[h] = gh
		if h == e.self {
			e.selfState = s
		}
		if c := validClaim(s["claim"]); c != nil && h != e.self {
			c.Host = h
			e.claims[h] = c
		}
	}
	return true
}

func (e *E) campaign(r Roster, ms int64, extra []string) map[string]bool {
	vs := uniq(append(voters(r), extra...))
	type rep struct {
		i int
		v map[string]any
	}
	ch := make(chan rep, len(vs))
	for i, h := range vs {
		go func(i int, h string) {
			ch <- rep{i, e.call(h, "POST", "/api/git/vote", map[string]any{"c": e.self, "ms": ms, "roster": r})}
		}(i, h)
	}
	replies := make([]map[string]any, len(vs))
	for range vs {
		x := <-ch
		replies[x.i] = x.v
	}
	granted := map[string]bool{}
	for i, h := range vs {
		r := replies[i]
		if r == nil {
			continue
		}
		if g, _ := r["granted"].(bool); g {
			granted[h] = true
		}
		e.adopt(r["roster"])
	}
	return granted
}

func (e *E) readPos() {
	if !e.posReading.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer e.posReading.Store(false)
		b, err := os.ReadFile(dbPosFile)
		if err != nil {
			e.txid.Store(-1)
			return
		}
		m := regexp.MustCompile(`^([0-9a-f]{16})/`).FindStringSubmatch(string(b))
		if m == nil {
			e.txid.Store(-1)
			return
		}
		v, err := strconv.ParseUint(m[1], 16, 64)
		if err != nil {
			e.txid.Store(-1)
			return
		}
		e.txid.Store(int64(v))
	}()
}

type local struct {
	gen, stamp    int
	inSync, force bool
}

func readLocal() local {
	b, _ := os.ReadFile(localFile)
	f := strings.Fields(strings.TrimSpace(string(b)))
	at := func(i int) string {
		if i < len(f) {
			return f[i]
		}
		return ""
	}
	num := func(s string) int {
		v, err := strconv.ParseFloat(s, 64)
		if err != nil || math.IsNaN(v) {
			return 0
		}
		return int(v)
	}
	return local{gen: num(at(0)), stamp: num(at(1)), inSync: at(2) == "1", force: at(3) == "1"}
}

func (e *E) me(l local) *claim {
	return &claim{Gen: l.gen, Stamp: l.stamp, Txid: int(e.txid.Load()), Host: e.self}
}

func (e *E) synced(l local) bool { return l.inSync && e.dbOK }

func better(a, b *claim) bool {
	if a.Gen != b.Gen {
		return a.Gen > b.Gen
	}
	if a.Stamp != b.Stamp {
		return a.Stamp > b.Stamp
	}
	if a.Txid != b.Txid {
		return a.Txid > b.Txid
	}
	return a.Host < b.Host
}

func (e *E) eligible(l local, r Roster) bool {
	if l.force || e.synced(l) {
		return true
	}
	gits := map[string]bool{}
	for _, g := range gitNames(r.Members) {
		gits[g] = true
	}
	if r.Prev != nil {
		for _, g := range gitNames(*r.Prev) {
			gits[g] = true
		}
	}
	delete(gits, e.self)
	for h := range gits {
		if e.claims[h] == nil && !(e.vouched && e.witnessed[h]) {
			return false
		}
	}
	return true
}

func (e *E) pending() []string {
	now := uptimeMS()
	members := map[string]bool{}
	for _, n := range names(e.known.Members) {
		members[n] = true
	}
	out := []string{}
	for h, t := range e.firstSeen {
		if !members[h] && now-t >= addAfterMS {
			out = append(out, h)
		}
	}
	sort.Strings(out)
	return out
}

func (e *E) desiredMembers(grantedLast map[string]bool) []Member {
	now := uptimeMS()
	out := map[string]Member{}
	for _, m := range e.known.Members {
		ls, ok := e.lastSeen[m.Name]
		if !ok {
			ls = now
		}
		if m.Name != e.self && now-ls > removeAfterMS {
			continue
		}
		g := m.Git
		if f, ok := e.gitFlag[m.Name]; ok {
			g = f
		}
		out[m.Name] = Member{Name: m.Name, Git: g, TB: bp(false)}
	}
	for _, h := range e.pending() {
		if grantedLast[h] {
			out[h] = Member{Name: h, Git: e.gitFlag[h], TB: bp(false)}
		}
	}
	out[e.self] = Member{Name: e.self, Git: true, TB: bp(true)}
	list := make([]Member, 0, len(out))
	for _, m := range out {
		list = append(list, m)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return list
}

func (e *E) nextRoster() (Roster, bool) {
	if e.committed != e.known.Epoch || !e.viewOK {
		return e.known, false
	}
	if e.known.Prev != nil {
		return Roster{Epoch: e.known.Epoch + 1, Members: e.known.Members, Prev: nil}, true
	}
	want := e.desiredMembers(e.grantedLast)
	if marshal(want) == marshal(e.known.Members) {
		return e.known, false
	}
	prev := e.known.Members
	return Roster{Epoch: e.known.Epoch + 1, Members: want, Prev: &prev}, true
}

func (e *E) saveKnown() { writeAtomic(rosterFile, marshal(e.known)) }

func (e *E) lead() {
	r, changed := e.nextRoster()
	if changed {
		e.known = r
		e.saveKnown()
		joint := ""
		if r.Prev != nil {
			joint = fmt.Sprintf(" (joint with %s)", describe(*r.Prev))
		}
		logf("roster %d: %s%s", r.Epoch, describe(r.Members), joint)
	}
	sent := uptimeMS()
	done := make(chan struct{})
	go func() { e.probeSafe(); close(done) }()
	granted := e.campaign(r, leaseMS, e.pending())
	<-done
	e.grantedLast = granted
	if quorum(r, granted, e.self) {
		e.leaseUntil = sent + leaseMS - leaseMarginMS
		e.committed = r.Epoch
	}
	if uptimeMS() >= e.leaseUntil {
		logf("lost the vote majority, stepping down")
		e.role = "none"
		e.master = ""
	}
}

// probeSafe the probe run beside a campaign: adopt is the shared write,
// both rare enough to tolerate the ordering
func (e *E) probeSafe() { e.probe() }

func (e *E) followOrCampaign(l local) {
	if !e.probe() {
		return
	}
	var best *claim
	for _, c := range e.sortedClaims() {
		if c.Role == "master" && (best == nil || better(c, best)) {
			best = c
		}
	}
	if best != nil {
		e.noMasterTicks = 0
		if best.Gen < l.gen {
			if e.refused != best.Host {
				logf("refusing to follow %s: its data (gen %d) is older than ours (gen %d), fix by hand", best.Host, best.Gen, l.gen)
			}
			e.refused = best.Host
			e.vouched = false
			e.vouchedAt = 0
			e.dbOK = false
			e.role = "none"
			e.master = ""
			return
		}
		e.refused = ""
		e.lastStall = ""
		e.dbOK = int(e.txid.Load()) >= best.Txid
		if e.synced(l) {
			e.vouchedAt = uptimeMS()
		}
		e.vouched = uptimeMS()-e.vouchedAt < vouchMS
		e.lastMaster = best.Host
		e.role = "servant"
		e.master = best.Host
		return
	}

	e.role = "none"
	e.master = ""
	e.noMasterTicks++
	named := e.namedSuccessor()
	if named != "" && named != e.self {
		return
	}
	if e.skip > 0 {
		e.skip--
		return
	}
	if uptimeMS() < e.holdUntil {
		return
	}
	if e.noMasterTicks < promoteGrace {
		return
	}

	boot := e.known.Epoch == 0 || l.force
	gone := []string{}
	if !boot && e.vouched {
		for _, h := range names(e.known.Members) {
			if e.witnessed[h] {
				gone = append(gone, h)
			}
		}
	}
	r := e.known
	same := true
	if boot {
		hosts := []string{}
		for h := range e.firstSeen {
			hosts = append(hosts, h)
		}
		sort.Strings(hosts)
		hosts = uniq(append(hosts, e.self))
		ms := []Member{}
		for _, h := range hosts {
			ms = append(ms, Member{Name: h, Git: h == e.self || e.gitFlag[h], TB: bp(h == e.self)})
		}
		sort.Slice(ms, func(i, j int) bool { return ms[i].Name < ms[j].Name })
		r = Roster{Epoch: e.known.Epoch + 1, Members: ms, Prev: nil}
		same = false
	} else if len(gone) > 0 {
		goneSet := map[string]bool{}
		for _, g := range gone {
			goneSet[g] = true
		}
		ms := []Member{}
		for _, m := range e.known.Members {
			if !goneSet[m.Name] {
				ms = append(ms, Member{Name: m.Name, Git: m.Git, TB: bp(m.Name == e.self)})
			}
		}
		r = Roster{Epoch: e.known.Epoch + 1, Members: ms, Prev: nil}
		same = false
	}
	member := false
	for _, m := range r.Members {
		if m.Name == e.self && m.Git {
			member = true
		}
	}
	if !member {
		e.stall("not a git member of the roster")
		return
	}
	if !e.eligible(l, r) {
		out := []string{}
		for _, h := range gitNames(r.Members) {
			if h != e.self && e.claims[h] == nil {
				out = append(out, h)
			}
		}
		who := strings.Join(out, ", ")
		if who == "" {
			who = "no host"
		}
		why := " (never vouched for the last master)"
		if e.vouched {
			why = " (waiting on tailscale to call them gone)"
		}
		e.stall(fmt.Sprintf("not in sync, and %s out of view%s", who, why))
		return
	}
	mine := e.me(l)
	for _, c := range e.sortedClaims() {
		if !l.force && named != e.self && better(c, mine) {
			e.stall(fmt.Sprintf("%s has newer data, waiting on it", c.Host))
			return
		}
	}
	if l.force {
		logf("forced: resetting roster to %s", describe(r.Members))
	} else if len(gone) > 0 {
		logf("%s offline per tailscale for %ds, roster without it: %s", strings.Join(gone, ", "), int(witnessMS/1000), describe(r.Members))
	}
	if !same {
		e.known = r
		e.saveKnown()
	}
	sent := uptimeMS()
	granted := e.campaign(r, leaseMS, nil)
	if !quorum(r, granted, e.self) {
		e.campaign(r, 0, nil)
		e.stall(fmt.Sprintf("%d of %d votes, no majority", len(granted), len(voters(r))))
		idx := indexOf(gitNames(r.Members), e.self)
		if idx < 0 {
			idx = 0
		}
		e.skip = idx + 1
		return
	}
	prev := e.claims[e.lastMaster]
	e.finalFrom = ""
	if prev != nil && prev.Role != "master" && prev.Gen >= l.gen {
		e.finalFrom = e.lastMaster
	}
	g := l.gen
	for _, c := range e.claims {
		if c.Gen > g {
			g = c.Gen
		}
	}
	e.gen = g + 1
	e.leaseUntil = sent + leaseMS - leaseMarginMS
	e.committed = r.Epoch
	e.role = "master"
	e.master = e.self
	e.vouched = false
	e.vouchedAt = 0
	e.lastStall = ""
	how := fmt.Sprintf("won %d of %d votes", len(granted), len(voters(r)))
	if len(gitNames(r.Members)) == 1 {
		how = "sole git host"
	}
	logf("%s (roster %d: %s), promoting self, gen %d", how, r.Epoch, describe(r.Members), e.gen)
}

func indexOf(xs []string, x string) int {
	for i, v := range xs {
		if v == x {
			return i
		}
	}
	return -1
}

// claims in view order is a JS Map's insertion order, sorted here: ties
// broken by better(), name last, so the order never decides
func (e *E) sortedClaims() []*claim {
	hs := make([]string, 0, len(e.claims))
	for h := range e.claims {
		hs = append(hs, h)
	}
	sort.Strings(hs)
	out := make([]*claim, len(hs))
	for i, h := range hs {
		out[i] = e.claims[h]
	}
	return out
}

func litefsUp() bool {
	b, err := os.ReadFile(litefsPidFile)
	return err == nil && strings.TrimSpace(string(b)) != ""
}

func (e *E) writeOut(l local) {
	if e.role == "master" && !litefsUp() {
		os.WriteFile(promotingFile, nil, 0o644)
	} else {
		os.Remove(promotingFile)
	}
	writeAtomic(leaseFile, fmt.Sprintf("%d\n", e.leaseUntil))
	g := l.gen
	if e.role == "master" && e.gen > g {
		g = e.gen
	}
	m := e.master
	if m == "" {
		m = "-"
	}
	ff := "-"
	if e.role == "master" && e.finalFrom != "" {
		ff = e.finalFrom
	}
	writeAtomic(decisionFile, fmt.Sprintf("%s %s %d %d %s\n", e.role, m, g, uptimeMS(), ff))
	e.writeClaim(l, g)
}

type claimOut struct {
	Host      string `json:"host"`
	Role      string `json:"role"`
	Master    string `json:"master"`
	Gen       int    `json:"gen"`
	Stamp     int    `json:"stamp"`
	Txid      int64  `json:"txid"`
	Eligible  bool   `json:"eligible"`
	Roster    int    `json:"roster"`
	HandoffTo string `json:"handoffTo"`
}

func (e *E) writeClaim(l local, g int) {
	h := ""
	if uptimeMS() < e.holdUntil {
		h = e.handoffTo
	}
	writeAtomic(claimFile, marshal(claimOut{
		Host: e.self, Role: e.role, Master: e.master, Gen: g, Stamp: l.stamp, Txid: e.txid.Load(),
		Eligible: e.role == "master" || e.synced(l), Roster: e.known.Epoch, HandoffTo: h,
	}))
}

func (e *E) canTakeOver(h string) bool {
	c := e.claims[h]
	if c == nil || c.Role != "servant" || c.Master != e.self || !c.Eligible {
		return false
	}
	for _, m := range e.known.Members {
		if m.Name == h && m.Git {
			return true
		}
	}
	return false
}

func (e *E) successor() string {
	var best *claim
	for _, c := range e.sortedClaims() {
		if e.canTakeOver(c.Host) && (best == nil || better(c, best)) {
			best = c
		}
	}
	if best == nil {
		return ""
	}
	return best.Host
}

func (e *E) passTiebreak(to string) {
	if e.known.Prev != nil || to == "" {
		return
	}
	members := make([]Member, len(e.known.Members))
	for i, m := range e.known.Members {
		members[i] = Member{Name: m.Name, Git: m.Git, TB: bp(m.Name == to)}
	}
	old := e.known.Members
	for _, prev := range []*[]Member{&old, nil} {
		r := Roster{Epoch: e.known.Epoch + 1, Members: members, Prev: prev}
		e.known = r
		e.saveKnown()
		if !quorum(r, e.campaign(r, leaseMS, nil), e.self) {
			return
		}
	}
	logf("%s is now the tiebreaker", to)
}

func (e *E) handOff(reason, to string) {
	suffix := ""
	if to != "" {
		suffix = " to " + to
	}
	logf("%s, handing off%s", reason, suffix)
	e.role = "none"
	e.master = ""
	e.handoffTo = to
	e.holdUntil = uptimeMS() + holdMS
	e.writeOut(readLocal())
	for litefsUp() {
		sent := uptimeMS()
		if quorum(e.known, e.campaign(e.known, leaseMS, nil), e.self) {
			e.leaseUntil = sent + leaseMS - leaseMarginMS
		}
		if uptimeMS() >= e.leaseUntil {
			return
		}
		l := readLocal()
		e.writeClaim(l, l.gen)
		time.Sleep(200 * time.Millisecond)
	}
	e.passTiebreak(to)
	e.campaign(e.known, 0, nil)
}

func (e *E) namedSuccessor() string {
	for _, c := range e.sortedClaims() {
		if c.HandoffTo != "" && (c.HandoffTo == e.self || e.claims[c.HandoffTo] != nil) {
			return c.HandoffTo
		}
	}
	return ""
}

func (e *E) handoffRequest() string {
	var req map[string]any
	if !util.ReadJSON(handoffFile, &req) || req == nil {
		return ""
	}
	os.Remove(handoffFile)
	at, ok := req["at"].(float64)
	if !ok || float64(time.Now().UnixMilli())-at > handoffMaxAgeMS {
		return ""
	}
	to, _ := req["to"].(string)
	if !e.canTakeOver(to) {
		logf("not handing off to %s: not an in-sync servant of ours", to)
		return ""
	}
	return to
}

func (e *E) tick() {
	if e.stopping.Load() {
		return
	}
	e.readPos()
	l := readLocal()
	leaving := false
	if e.role == "master" && e.selfState != nil {
		upd, _ := e.selfState["updating"].(bool)
		boot, _ := e.selfState["bootId"].(string)
		if upd && e.handedOffBoot != boot {
			leaving = true
			e.handedOffBoot = boot
		}
	}
	if to := e.successor(); leaving && to != "" {
		e.handOff("an update is about to restart this host", to)
	} else if e.role == "master" {
		if to := e.handoffRequest(); to != "" {
			e.handOff("asked from the frontend", to)
		} else {
			if leaving {
				logf("an update is about to restart this host, no servant to take over, staying master")
			}
			e.lead()
		}
	} else {
		e.followOrCampaign(l)
	}
	if !e.stopping.Load() {
		e.writeOut(l)
	}
}

// Main runs the elector until SIGTERM
func Main() int {
	b, err := os.ReadFile(filepath.Join(stateDir, "self-host"))
	if err != nil {
		logf("can't read %s: %v", filepath.Join(stateDir, "self-host"), err)
		return 1
	}
	e := &E{
		self:        strings.TrimSpace(string(b)),
		known:       emptyRoster(),
		firstSeen:   map[string]int64{},
		lastSeen:    map[string]int64{},
		gitFlag:     map[string]bool{},
		claims:      map[string]*claim{},
		witnessed:   map[string]bool{},
		pollMS:      tickMS,
		role:        "none",
		committed:   -1,
		grantedLast: map[string]bool{},
		client:      &http.Client{Timeout: probeTimeout, Transport: &http.Transport{Proxy: nil}},
	}
	e.txid.Store(-1)
	var saved any
	if util.ReadJSON(rosterFile, &saved) {
		if r := ValidRoster(saved); r != nil {
			e.known = *r
		}
	}
	now := uptimeMS()
	for _, h := range voters(e.known) {
		e.lastSeen[h] = now
	}
	e.writeOut(readLocal())
	desc := describe(e.known.Members)
	if desc == "" {
		desc = "(none yet)"
	}
	logf("starting as %s, roster %d: %s", e.self, e.known.Epoch, desc)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	for {
		t0 := time.Now()
		func() {
			defer func() {
				if r := recover(); r != nil {
					logf("tick failed: %v", r)
				}
			}()
			e.tick()
		}()
		wait := e.pollMS
		if tickMS < wait {
			wait = tickMS
		}
		d := time.Duration(wait)*time.Millisecond - time.Since(t0)
		if d < 0 {
			d = 0
		}
		select {
		case <-sig:
			e.stopping.Store(true)
			os.Remove(claimFile)
			if e.role == "master" {
				e.handOff("shutting down", e.successor())
			} else {
				e.campaign(e.known, 0, nil)
			}
			return 0
		case <-time.After(d):
		}
	}
}
