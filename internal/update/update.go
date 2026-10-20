// Package update: this host's own update, the lock it publishes while driving
// one, and the mesh's, every host at once
package update

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/clock"
	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	selfHost    = os.Getenv("SELF_HOST")
	stateDir    = util.StateDir
	chainFile   = filepath.Join(stateDir, "update-chain.json")
	VersionFile = util.Env("VERSION_FILE", filepath.Join(util.RepoDir, "VERSION"))
	requestFile = filepath.Join(stateDir, "update-request.json")
	agentFile   = filepath.Join(stateDir, "update-agent.json")
	feedURL     = util.Env("PHOSPHORUS_FEED_URL", "https://github.com/pmghartman/phosphorus/releases/download/update/latest.json")
)

const (
	feedTTLMS       = 600000
	agentPickupMS   = 60000
	updateTimeoutMS = 1200000
	connectTimeout  = 2 * time.Second
	swapTimeoutMS   = 120000
	peerQuietMS     = 180000
	peerCapMS       = 1800000
	chainMaxAgeMS   = 1800000
	chainLingerMS   = 120000
	// StartGraceMS nothing moving until they pass
	StartGraceMS = 5000
)

func logf(f string, a ...any) { log.Printf("[update] "+f, a...) }

// ReadVersion a VERSION file trimmed, "" when unreadable
func ReadVersion(file string) string {
	b, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// Newer numeric, part by part, 0.13 < 0.13.1 < 0.14
func Newer(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	num := func(xs []string, i int) float64 {
		if i >= len(xs) {
			return 0
		}
		f, err := strconv.ParseFloat(xs[i], 64)
		if err != nil {
			return 0
		}
		return f
	}
	for i := 0; i < n; i++ {
		if d := num(pa, i) - num(pb, i); d != 0 {
			return d > 0
		}
	}
	return false
}

var (
	feedMu sync.Mutex
	feed   = struct {
		at                   int64
		latest, notes, error string
	}{}
)

// Check the newest release against this host's, cached
func Check(force bool) map[string]any {
	feedMu.Lock()
	defer feedMu.Unlock()
	if force || util.Now()-feed.at > feedTTLMS {
		c := &http.Client{Timeout: 10 * time.Second}
		err := func() error {
			r, err := c.Get(feedURL)
			if err != nil {
				return err
			}
			defer r.Body.Close()
			if r.StatusCode < 200 || r.StatusCode >= 300 {
				return fmt.Errorf("feed answered %d", r.StatusCode)
			}
			var j map[string]any
			b, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(b, &j); err != nil {
				return err
			}
			feed.at = util.Now()
			feed.latest = util.Str(j["version"])
			feed.notes = util.Str(j["notes"])
			feed.error = ""
			return nil
		}()
		if err != nil {
			feed.at = util.Now()
			feed.error = err.Error()
		}
	}
	cur := ReadVersion(VersionFile)
	return map[string]any{
		"current": cur, "latest": feed.latest, "notes": feed.notes, "error": feed.error,
		"available": feed.latest != "" && cur != "" && Newer(feed.latest, cur), "checkedAt": feed.at,
	}
}

// --- this host's own update ------------------------------------------------

type result struct {
	ok          bool
	current     bool
	to          string
	error       string
	unreachable bool
}

var (
	outcomeHook = func(map[string]any) {}
	finishHook  = func(*Chain) {}
)

// OnOutcome server's, for disk and chat
func OnOutcome(fn func(map[string]any)) { outcomeHook = fn }

// OnFinish a chain ending, however it ended
func OnFinish(fn func(*Chain)) { finishHook = fn }

func uuid() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// UUID a random v4 id
func UUID() string { return uuid() }

// RunLocalUpdate hands the update to the host's agent and waits for its verdict
func RunLocalUpdate() result {
	outcomeHook(map[string]any{"state": "running"})
	done := func(r result) result {
		if r.ok {
			outcomeHook(map[string]any{"state": "ok", "current": r.current, "version": r.to})
		} else {
			outcomeHook(map[string]any{"state": "failed", "error": r.error})
		}
		return r
	}
	id := uuid()
	if err := util.WriteJSONAtomic(requestFile, map[string]any{"id": id, "at": util.Now()}); err != nil {
		return done(result{error: "couldn't request the update: " + err.Error()})
	}
	started := util.Now()
	for util.Now()-started < updateTimeoutMS {
		time.Sleep(2 * time.Second)
		a := util.ReadJSONMap(agentFile)
		if a == nil || a["id"] != id {
			if util.Now()-started > agentPickupMS {
				if _, err := os.Stat(requestFile); err == nil {
					os.Remove(requestFile)
					return done(result{error: "no update agent on this host: reinstall from the latest release"})
				}
			}
			continue
		}
		switch a["state"] {
		case "ok":
			to := util.Str(a["version"])
			if to == "" {
				to = ReadVersion(VersionFile)
			}
			return done(result{ok: true, current: util.Truthy(a["current"]), to: to})
		case "failed":
			e := util.Str(a["error"])
			if e == "" {
				e = "update failed"
			}
			if len(e) > 500 {
				e = e[:500]
			}
			return done(result{error: e})
		}
	}
	return done(result{error: "update timed out"})
}

// --- peers ------------------------------------------------------------------

func peerReq(host string, r util.Req) (util.Response, error) {
	r.Host = host
	r.Port = util.FrontendPort
	if r.Timeout == 0 {
		r.Timeout = connectTimeout
	}
	return util.RequestJSON(r)
}

func kickOff(host string) result {
	r, err := peerReq(host, util.Req{Method: "POST", Path: "/api/update/local", Body: map[string]any{}, ConnectTimeout: connectTimeout})
	if err != nil {
		return result{unreachable: true, error: err.Error()}
	}
	if r.Status == 202 {
		return result{ok: true}
	}
	e := fmt.Sprintf("status %d", r.Status)
	if m := util.Obj(util.Decode(r.Body)); m != nil && util.Truthy(m["error"]) {
		e = util.JSString(m["error"])
	}
	if len(e) > 500 {
		e = e[:500]
	}
	return result{error: e}
}

func fetchStatus(host string) (map[string]any, error) {
	r, err := peerReq(host, util.Req{Path: "/api/update/local/status"})
	if err != nil {
		return nil, err
	}
	m := util.Obj(util.Decode(r.Body))
	if m == nil {
		return nil, fmt.Errorf("unreadable status")
	}
	return m, nil
}

type selfInfo struct{ bootID, version, platform string }

func fetchSelf(host string) selfInfo {
	r, err := peerReq(host, util.Req{Path: "/api/mesh/snapshot"})
	if err != nil {
		return selfInfo{}
	}
	s := util.Obj(util.Obj(util.Decode(r.Body))["self"])
	return selfInfo{util.Str(s["bootId"]), util.Str(s["version"]), util.Str(s["platform"])}
}

func peerAddr(host string) string {
	if a := util.TailnetIP(host); a != "" {
		return a
	}
	return host
}

// callPeerUpdate a peer's update asked for and followed; its boot and last
// verdict noted first, so a watch picked up after this host restarts can tell
func callPeerUpdate(host string, note func(map[string]string)) result {
	addr := peerAddr(host)
	before := fetchSelf(addr)
	base := ""
	if s, err := fetchStatus(addr); err == nil && util.Truthy(s["at"]) {
		base = fmt.Sprint(s["at"])
	}
	note(map[string]string{"from": before.version, "boot": before.bootID, "base": base})
	if k := kickOff(addr); !k.ok {
		return k
	}
	return watchPeer(host, before.version, before.bootID, base, "asked", note)
}

// watchPeer a peer's update followed to its verdict: its agent's, then its new boot
func watchPeer(host, fromVersion, fromBoot, base, stage string, note func(map[string]string)) result {
	addr := peerAddr(host)
	// the stage each progress bar weighs the host by, every peer at once
	at := func(s string) {
		if s != stage {
			stage = s
			note(map[string]string{"stage": s})
		}
	}
	note(map[string]string{"stage": stage})
	capAt := util.Now() + peerCapMS
	quietUntil := util.Now() + peerQuietMS
	var swapDeadline int64
	for util.Now() < capAt {
		time.Sleep(clock.Interval())
		status, err := fetchStatus(addr)
		if err != nil {
			// silent once installing: its service restarting onto the new release
			if stage == "installing" {
				at("restarting")
			}
			if util.Now() > quietUntil {
				return result{unreachable: true, error: "stopped answering during its update"}
			}
			continue
		}
		quietUntil = util.Now() + peerQuietMS
		if swapDeadline != 0 && util.Now() > swapDeadline {
			return result{error: "the restart never landed, see that host's phosphorus log"}
		}
		if status["state"] == "failed" {
			e := util.Str(status["error"])
			if e == "" {
				e = "update failed"
			}
			return result{error: e}
		}
		if status["state"] == "running" && stage == "asked" {
			at("installing")
		}
		if status["state"] != "ok" || (base != "" && fmt.Sprint(status["at"]) == base) {
			continue
		}
		if util.Truthy(status["current"]) {
			return result{ok: true, current: true, to: fromVersion}
		}
		after := fetchSelf(addr)
		if fromBoot == "" || (after.bootID != "" && after.bootID != fromBoot) {
			to := after.version
			if to == "" {
				to = util.Str(status["version"])
			}
			return result{ok: true, to: to}
		}
		at("restarting")
		if swapDeadline == 0 {
			swapDeadline = util.Now() + swapTimeoutMS
		}
	}
	return result{unreachable: true, error: "gave up waiting for the update to finish"}
}

// --- chain state ------------------------------------------------------------

// Chain the mesh update, on the initiator only
type Chain struct {
	ID           string                       `json:"id"`
	Order        []string                     `json:"order"`
	Results      map[string]string            `json:"results"`
	Versions     map[string]map[string]string `json:"versions"`
	Errors       map[string]string            `json:"errors"`
	Details      map[string]string            `json:"details,omitempty"`
	Target       string                       `json:"target"`
	CurrentIndex int                          `json:"currentIndex"`
	Paused       bool                         `json:"paused"`
	PauseReason  string                       `json:"pauseReason"`
	Cancelled    bool                         `json:"cancelled"`
	Done         bool                         `json:"done"`
	StartedAt    string                       `json:"startedAt"`
	FinishedAt   int64                        `json:"finishedAt,omitempty"`
	SavedAt      int64                        `json:"savedAt,omitempty"`
	AlertSeq     *float64                     `json:"alertSeq,omitempty"`
}

var (
	cmu   sync.Mutex
	chain *Chain
	wake  chan struct{}
)

func chainStatusLocked() map[string]any {
	if chain == nil {
		return nil
	}
	if chain.Done && util.Now()-chain.FinishedAt > chainLingerMS {
		return nil
	}
	return map[string]any{
		"chainId": chain.ID, "order": chain.Order, "results": chain.Results, "versions": chain.Versions,
		"target": chain.Target, "currentIndex": chain.CurrentIndex, "paused": chain.Paused,
		"pauseReason": chain.PauseReason, "errors": chain.Errors, "done": chain.Done, "finishedAt": chain.FinishedAt,
	}
}

func sharedLocked() map[string]any {
	if chainStatusLocked() == nil {
		return nil
	}
	return map[string]any{
		"initiator": selfHost, "chainId": chain.ID, "startedAt": chain.StartedAt, "paused": chain.Paused, "done": chain.Done,
		"pauseReason": chain.PauseReason, "order": chain.Order, "results": chain.Results, "errors": chain.Errors,
	}
}

// SharedChain published to peers
func SharedChain() any {
	cmu.Lock()
	defer cmu.Unlock()
	if c := sharedLocked(); c != nil {
		return c
	}
	return nil
}

// OwnLock while this host drives a chain
func OwnLock() any {
	cmu.Lock()
	defer cmu.Unlock()
	c := sharedLocked()
	if c == nil || c["done"] == true {
		return nil
	}
	return c
}

// MeshLock the initiator's own chain over the merged peer view
func MeshLock() any {
	if l := OwnLock(); l != nil {
		return l
	}
	return mesh.Lock()
}

// ChainStatus this host's chain, nil when none
func ChainStatus() any {
	cmu.Lock()
	defer cmu.Unlock()
	if c := chainStatusLocked(); c != nil {
		return c
	}
	return nil
}

func saveLocked() {
	if chain == nil {
		return
	}
	chain.SavedAt = util.Now()
	util.WriteJSONAtomic(chainFile, chain)
}

func noteLocked(host string, fields map[string]string) {
	v := chain.Versions[host]
	if v == nil {
		v = map[string]string{}
		chain.Versions[host] = v
	}
	for k, x := range fields {
		v[k] = x
	}
	if to := v["to"]; to != "" && to != v["from"] {
		chain.Target = to
	}
	saveLocked()
}

func buildOrder(gitHosts []string) []string {
	git := map[string]bool{}
	for _, h := range gitHosts {
		git[h] = true
	}
	seen := map[string]bool{}
	peers := []string{}
	for _, d := range mesh.Tailnet() {
		n, _ := d["name"].(string)
		if (d["phosphorus"] == true || d["phosphorusSeen"] == true) && n != "" && n != selfHost && !seen[n] {
			seen[n] = true
			peers = append(peers, n)
		}
	}
	rank := func(m string) int {
		if git[m] {
			return 1
		}
		return 0
	}
	sort.SliceStable(peers, func(i, j int) bool {
		if rank(peers[i]) != rank(peers[j]) {
			return rank(peers[i]) < rank(peers[j])
		}
		return util.LocaleCompare(peers[i], peers[j]) < 0
	})
	return append(peers, selfHost)
}

func finishLocked(reason string) {
	for _, m := range chain.Order {
		if r := chain.Results[m]; r == "pending" || r == "running" {
			chain.Results[m] = "skipped"
		}
	}
	chain.Paused = false
	chain.Done = true
	chain.FinishedAt = util.Now()
	saveLocked()
	logf("chain %s %s", chain.ID[:8], reason)
	c := *chain
	go finishHook(&c)
}

var briefRes = []struct {
	re  *regexp.Regexp
	out string
}{
	{regexp.MustCompile(`agent|feed|apt`), "update failed"},
	{regexp.MustCompile(`pull failed`), "pull failed"},
	{regexp.MustCompile(`restart never landed`), "restart failed"},
	{regexp.MustCompile(`build failed`), "build failed"},
	{regexp.MustCompile(`timed out|gave up`), "timed out"},
}

func brief(r result) string {
	for _, b := range briefRes {
		if b.re.MatchString(r.error) {
			return b.out
		}
	}
	if r.unreachable {
		return "unreachable"
	}
	return "failed"
}

// Remember the update warning's chat seq, kept across the swap
func Remember(alertSeq float64) {
	cmu.Lock()
	defer cmu.Unlock()
	if chain == nil {
		return
	}
	chain.AlertSeq = &alertSeq
	saveLocked()
}

// RestoreChain a chain this host drove through its own restart: its own step
// closed out by this boot, the peers still updating watched again to their verdicts
func RestoreChain() {
	var saved Chain
	if !util.ReadJSON(chainFile, &saved) || saved.Done || saved.Order == nil {
		return
	}
	if util.Now()-saved.SavedAt > chainMaxAgeMS {
		return
	}
	cmu.Lock()
	defer cmu.Unlock()
	chain = &saved
	chain.Paused = false
	if chain.Versions == nil {
		chain.Versions = map[string]map[string]string{}
	}
	if chain.Errors == nil {
		chain.Errors = map[string]string{}
	}
	if chain.Results == nil {
		chain.Results = map[string]string{}
	}
	if chain.Results[selfHost] == "running" {
		chain.Results[selfHost] = "ok"
		noteLocked(selfHost, map[string]string{"to": ReadVersion(VersionFile), "stage": ""})
	}
	peers := []string{}
	for _, m := range chain.Order {
		if m != selfHost && chain.Results[m] == "running" {
			peers = append(peers, m)
		}
	}
	if len(peers) == 0 {
		finishLocked("finished after the swap")
		return
	}
	logf("chain %s back after the swap, still watching %s", chain.ID[:8], strings.Join(peers, ", "))
	go func() {
		var wg sync.WaitGroup
		for _, h := range peers {
			cmu.Lock()
			v := chain.Versions[h]
			from, boot, base, stage := v["from"], v["boot"], v["base"], v["stage"]
			cmu.Unlock()
			if stage == "" {
				stage = "asked"
			}
			wg.Add(1)
			go func(host string) {
				defer wg.Done()
				r := watchPeer(host, from, boot, base, stage, func(f map[string]string) { cmu.Lock(); noteLocked(host, f); cmu.Unlock() })
				cmu.Lock()
				recordLocked(host, r)
				cmu.Unlock()
			}(h)
		}
		wg.Wait()
		cmu.Lock()
		chain.CurrentIndex = len(chain.Order)
		finishLocked("finished")
		cmu.Unlock()
	}()
}

// record a host's outcome, under cmu
func recordLocked(host string, r result) bool {
	if r.ok {
		chain.Results[host] = "ok"
		if r.current {
			chain.Results[host] = "current"
		}
		noteLocked(host, map[string]string{"to": r.to})
		return true
	}
	chain.Results[host] = "fail"
	if r.unreachable {
		chain.Results[host] = "unreachable"
	}
	chain.Errors[host] = brief(r)
	if chain.Details == nil {
		chain.Details = map[string]string{}
	}
	chain.Details[host] = r.error
	logf("%s failed: %s", host, r.error)
	saveLocked()
	return false
}

// runChain every host at once, this one too, each through its own installer;
// this host's swap ends the driver, RestoreChain picking the rest up on its boot
func runChain() {
	time.Sleep(StartGraceMS * time.Millisecond)
	cmu.Lock()
	if chain.Cancelled {
		finishLocked("cancelled")
		cmu.Unlock()
		return
	}
	hosts := slices.Clone(chain.Order)
	for _, h := range hosts {
		chain.Results[h] = "running"
	}
	cmu.Unlock()
	logf("updating %s at once", strings.Join(hosts, ", "))
	var wg sync.WaitGroup
	for _, h := range hosts {
		wg.Add(1)
		go func(host string) {
			defer wg.Done()
			var r result
			if host == selfHost {
				cmu.Lock()
				noteLocked(selfHost, map[string]string{"from": ReadVersion(VersionFile), "stage": "installing"})
				cmu.Unlock()
				r = RunLocalUpdate()
			} else {
				r = callPeerUpdate(host, func(f map[string]string) { cmu.Lock(); noteLocked(host, f); cmu.Unlock() })
			}
			cmu.Lock()
			if !recordLocked(host, r) {
				logf("%s: %s", host, r.error)
			}
			cmu.Unlock()
		}(h)
	}
	wg.Wait()
	cmu.Lock()
	chain.CurrentIndex = len(chain.Order)
	finishLocked("finished")
	cmu.Unlock()
}

func resumeLocked() {
	if wake != nil {
		close(wake)
		wake = nil
	}
}

// Start a chain, or who holds the lock
func Start(gitHosts []string) map[string]any { return StartOnly(gitHosts, nil) }

// StartOnly a chain over only those hosts, every host when only is empty
func StartOnly(gitHosts, only []string) map[string]any {
	if held := util.Obj(MeshLock()); held != nil {
		return map[string]any{"locked": held["initiator"]}
	}
	order := buildOrder(gitHosts)
	if len(only) > 0 {
		kept := []string{}
		for _, h := range order {
			if slices.Contains(only, h) {
				kept = append(kept, h)
			}
		}
		if len(kept) == 0 {
			return map[string]any{"error": "none of " + strings.Join(only, ", ") + " is a phosphorus host on the mesh"}
		}
		order = kept
	}
	cmu.Lock()
	results := map[string]string{}
	for _, m := range order {
		results[m] = "pending"
	}
	chain = &Chain{
		ID: uuid(), Order: order, Results: results, Versions: map[string]map[string]string{}, Errors: map[string]string{},
		StartedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	logf("chain %s starting over %s", chain.ID[:8], strings.Join(order, ", "))
	saveLocked()
	id := chain.ID
	cmu.Unlock()
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logf("chain failed: %v", r)
				cmu.Lock()
				finishLocked("aborted")
				cmu.Unlock()
			}
		}()
		runChain()
	}()
	return map[string]any{"chainId": id, "order": order}
}

// Cancel stops a chain still in its grace, before any host is asked
func Cancel() bool {
	cmu.Lock()
	defer cmu.Unlock()
	if chain == nil || chain.Done {
		return false
	}
	chain.Cancelled = true
	if chain.Paused {
		resumeLocked()
	}
	return true
}

// Proceed past a pause; a chain running every host at once never pauses
func Proceed() bool {
	cmu.Lock()
	defer cmu.Unlock()
	if chain == nil || chain.Done || !chain.Paused {
		return false
	}
	resumeLocked()
	return true
}
