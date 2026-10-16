// Package mesh: the one loop on the clock, own services refreshed, every
// tailnet peer polled, both merged into the routing table
package mesh

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/clock"
	"github.com/pmghartman/phosphorus/internal/gamedns"
	"github.com/pmghartman/phosphorus/internal/proxy"
	"github.com/pmghartman/phosphorus/internal/services"
	"github.com/pmghartman/phosphorus/internal/sshrelay"
	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	stateDir      = util.StateDir
	selfHost      = os.Getenv("SELF_HOST")
	selfHostFile  = filepath.Join(stateDir, "self-host")
	sshConfigFile = filepath.Join(stateDir, "ssh_config")
	tsAPIKey      = os.Getenv("TS_API_KEY")
	notes         = util.NewNotes("mesh")
	missThreshold = int(math.Max(3, math.Ceil(1500/float64(clock.FastMS))))
)

const (
	pollTimeout    = 700 * time.Millisecond
	discoverIdleMS = 5000
	discoverHotMS  = 1000
	gitMaxAgeMS    = 3000
	modelMaxAgeMS  = 5000
	tsAPI          = "https://api.tailscale.com/api/v2"
	splitDNSMS     = 30000
	guestTTLMS     = 3 * 24 * 3600 * 1000
	guestSweepMS   = 10 * 60 * 1000
)

// Hooks server's: chat and presence in, own platform and lock out
type Hooks struct {
	MergeChat     func([]any)
	MergePresence func(map[string][]any)
	Platform      func() string
	OwnLock       func() any
	HostServices  func(host string) []map[string]any
}

var hooks = Hooks{
	MergeChat: func([]any) {}, MergePresence: func(map[string][]any) {}, Platform: func() string { return "" },
	OwnLock: func() any { return nil }, HostServices: func(string) []map[string]any { return nil },
}

// --- discovery -------------------------------------------------------------

type peer struct {
	host, ip, os string
	online       bool
}

var (
	mu           sync.RWMutex
	selfIP       string
	hostIPs      = map[string]string{}
	offlineSince = map[string]int64{}
	lastDiscover int64
	lastPeers    []peer
	hasPeers     bool
)

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)
var edgeDash = regexp.MustCompile(`^-+|-+$`)

// HostOf a tailnet DNS name as supervisor.sh derives SELF_HOST
func HostOf(dns string) string {
	s := strings.ToLower(strings.Split(strings.TrimSuffix(dns, "."), ".")[0])
	return edgeDash.ReplaceAllString(nonAlnum.ReplaceAllString(s, "-"), "")
}

func v4(ips []string) string {
	for _, a := range ips {
		if strings.Contains(a, ".") {
			return a
		}
	}
	return ""
}

func discoverPeers() []peer {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tailscale", "status", "--json").Output()
	var status struct {
		Self struct {
			DNSName      string
			TailscaleIPs []string
		}
		Peer map[string]struct {
			DNSName      string
			TailscaleIPs []string
			Online       bool
			OS           string
		}
	}
	if err == nil {
		err = json.Unmarshal(out, &status)
	}
	if err != nil {
		notes.Note("tailscale", "can't reach tailscaled to list peers: "+err.Error())
		return nil
	}
	notes.Clear("tailscale")
	mu.Lock()
	selfIP = v4(status.Self.TailscaleIPs)
	mu.Unlock()
	if selfHost != "" {
		if renamed := HostOf(status.Self.DNSName); renamed != "" && renamed != selfHost {
			notes.Log(fmt.Sprintf("renamed on the tailnet to %s, restarting to follow", renamed))
			util.FlushWrites()
			os.Exit(1)
		}
	}
	peers := []peer{}
	keys := make([]string, 0, len(status.Peer))
	for k := range status.Peer {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		p := status.Peer[k]
		h := HostOf(p.DNSName)
		if h == "" || h == selfHost {
			continue
		}
		ip := v4(p.TailscaleIPs)
		if ip == "" {
			ip = h
		}
		peers = append(peers, peer{h, ip, p.OS, p.Online})
	}
	return peers
}

// OfflineMS per host, only while tailscale itself still answers
func OfflineMS() map[string]int64 {
	mu.RLock()
	defer mu.RUnlock()
	out := map[string]int64{}
	if util.Now()-lastDiscover > 3*discoverIdleMS {
		return out
	}
	for h, t := range offlineSince {
		out[h] = util.Now() - t
	}
	return out
}

func knownPeers() ([]peer, bool) {
	maxAge := int64(discoverIdleMS)
	if clock.IsHot() {
		maxAge = discoverHotMS
	}
	mu.RLock()
	if hasPeers && util.Now()-lastDiscover < maxAge {
		p := lastPeers
		mu.RUnlock()
		return p, true
	}
	mu.RUnlock()
	found := discoverPeers()
	mu.Lock()
	defer mu.Unlock()
	if found == nil {
		return lastPeers, hasPeers
	}
	lastDiscover = util.Now()
	online := map[string]bool{}
	for _, p := range found {
		if p.online {
			online[p.host] = true
		}
	}
	for h := range online {
		delete(offlineSince, h)
	}
	for _, p := range append(append([]peer{}, found...), lastPeers...) {
		if _, ok := offlineSince[p.host]; !online[p.host] && !ok {
			offlineSince[p.host] = lastDiscover
		}
	}
	lastPeers = found
	hasPeers = true
	return found, true
}

// --- peer polling ----------------------------------------------------------

type peerState struct {
	entries      []map[string]any
	presence     []any
	lock, chain  any
	git, model   any
	platform     string
	version      string
	misses       int
	lastSeq      float64
	chat         []any
	answered     bool
	everAnswered bool
	fp           string
	sys          string
	projects     []any
	answeredAt   int64
}

var peerStates = map[string]*peerState{}

func stateFor(h string) *peerState {
	s := peerStates[h]
	if s == nil {
		s = &peerState{entries: []map[string]any{}, presence: []any{}}
		peerStates[h] = s
	}
	return s
}

func retire(st *peerState) {
	st.entries = []map[string]any{}
	st.presence = []any{}
	st.lock, st.chain, st.git, st.model = nil, nil, nil, nil
	st.projects = []any{}
}

var pollClient = &http.Client{Timeout: pollTimeout, Transport: &http.Transport{Proxy: nil, MaxIdleConnsPerHost: 4}}

func fetchSnapshot(host, path string) (map[string]any, error) {
	res, err := pollClient.Get(fmt.Sprintf("http://%s:%d%s", host, util.FrontendPort, path))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if res.StatusCode != 200 || json.Unmarshal(b, &m) != nil || m == nil {
		return nil, fmt.Errorf("status %d", res.StatusCode)
	}
	return m, nil
}

func objOrNil(v any, key string) any {
	m, ok := v.(map[string]any)
	if !ok || m == nil {
		return nil
	}
	if key != "" && !util.Truthy(m[key]) {
		return nil
	}
	return m
}

func pollPeer(p peer) {
	mu.Lock()
	st := stateFor(p.host)
	since := st.lastSeq
	mu.Unlock()
	snap, err := fetchSnapshot(p.ip, "/api/mesh/snapshot?since="+util.JSNum(since))
	mu.Lock()
	defer mu.Unlock()
	if err != nil {
		clock.MarkHot()
		st.misses++
		st.chat = nil
		if st.misses >= missThreshold {
			retire(st)
		}
		notes.Note("peer:"+p.host, fmt.Sprintf("%s is not answering on port %d, is phosphorus running there?", p.host, util.FrontendPort))
		return
	}
	mu.Unlock()
	published := hooks.HostServices(p.host)
	mu.Lock()
	var entries []map[string]any
	if published != nil {
		entries = published
	} else if arr, ok := snap["services"].([]any); ok {
		for _, x := range arr {
			m, _ := x.(map[string]any)
			entries = append(entries, m)
		}
	}
	if entries == nil {
		entries = []map[string]any{}
	}
	bad := ""
	for _, e := range entries {
		if bad = proxy.RowError(e); bad != "" {
			break
		}
	}
	if bad != "" {
		notes.Note("bad:"+p.host, fmt.Sprintf("%s published a bad service, keeping its last good list: %s", p.host, bad))
	} else {
		st.entries = entries
		notes.Clear("bad:" + p.host)
	}
	st.presence, _ = snap["presence"].([]any)
	if st.presence == nil {
		st.presence = []any{}
	}
	st.chat, _ = snap["chat"].([]any)
	self, _ := snap["self"].(map[string]any)
	if s, ok := self["platform"].(string); ok {
		st.platform = s
	}
	if s, ok := self["version"].(string); ok {
		st.version = s
	}
	st.lock = objOrNil(snap["lock"], "initiator")
	st.chain = objOrNil(snap["chain"], "initiator")
	st.git = objOrNil(snap["git"], "")
	st.model = objOrNil(snap["model"], "")
	st.sys, _ = snap["sysDigest"].(string)
	st.projects = []any{}
	if arr, ok := snap["projects"].([]any); ok {
		for _, x := range arr {
			if m, ok := x.(map[string]any); ok && m["host"] == p.host {
				st.projects = append(st.projects, x)
			}
		}
	}
	st.answeredAt = util.Now()
	fp := string(util.Marshal([]any{st.entries, st.presence, st.lock, st.chain, st.platform, st.version, st.sys, st.projects}))
	if fp != st.fp || len(st.chat) > 0 || !st.answered {
		defer clock.MarkHot()
	}
	st.fp = fp
	st.misses = 0
	st.answered = true
	st.everAnswered = true
	notes.Note("peer:"+p.host, p.host+" is online")
}

var lastPresence string

func handOn() {
	mu.Lock()
	peers := map[string][]any{}
	var arrived []*peerState
	for h, st := range peerStates {
		if len(st.presence) > 0 {
			peers[h] = st.presence
		}
		if len(st.chat) > 0 {
			arrived = append(arrived, st)
		}
	}
	chat := []any{}
	for _, st := range arrived {
		chat = append(chat, st.chat...)
	}
	mu.Unlock()
	if len(arrived) > 0 {
		hooks.MergeChat(chat)
		mu.Lock()
		for _, st := range arrived {
			for _, x := range st.chat {
				if m, ok := x.(map[string]any); ok {
					if s, ok := m["seq"].(float64); ok && s > st.lastSeq {
						st.lastSeq = s
					}
				}
			}
			st.chat = nil
		}
		mu.Unlock()
	}
	j := string(util.Marshal(peers))
	if j != lastPresence {
		lastPresence = j
		hooks.MergePresence(peers)
	}
}

// --- games and split DNS ---------------------------------------------------

var (
	gameIPs  = map[string]string{}
	gameDNS  *gamedns.Server
	ipv4Only = util.IsIPv4
)

func mapGames(rows []map[string]any) map[string]string {
	rank := func(r map[string]any) string {
		h, _ := r["host"].(string)
		if r["status"] == "online" {
			return "0:" + h
		}
		return "1:" + h
	}
	games := []map[string]any{}
	for _, r := range rows {
		if r["type"] == "game" {
			games = append(games, r)
		}
	}
	sort.SliceStable(games, func(i, j int) bool { return util.LocaleCompare(rank(games[i]), rank(games[j])) < 0 })
	out := map[string]string{}
	for _, r := range games {
		name := util.JSString(r["name"])
		if _, dup := out[name]; dup {
			first := ""
			for _, g := range games {
				if util.JSString(g["name"]) == name {
					first, _ = g["host"].(string)
					break
				}
			}
			notes.Note("dup:"+name, fmt.Sprintf("game %s is declared on more than one host, %s.%s goes to %s", name, name, gamedns.Zone, first))
			continue
		}
		h, _ := r["host"].(string)
		if ip := hostIPs[h]; ipv4Only(ip) {
			out[name] = ip
		}
	}
	return out
}

var tsClient = &http.Client{Timeout: 10 * time.Second}

func tsAPICall(method, path string, body any) (any, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(util.Marshal(body))
	}
	req, _ := http.NewRequest(method, tsAPI+path, rd)
	req.Header.Set("Authorization", "Bearer "+tsAPIKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := tsClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode == 401 {
		return nil, errors.New("TS_API_KEY was rejected, expired? renew it in .env")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("%s %s got status %d: %s", method, path, res.StatusCode, strings.TrimSpace(string(b)))
	}
	if len(b) == 0 {
		return nil, nil
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, err
	}
	return v, nil
}

var lastSplitSync, lastGuestSweep int64

func syncSplitDNS(ns []string) {
	if tsAPIKey == "" {
		notes.Note("split-dns", fmt.Sprintf("TS_API_KEY unset, keep the .%s split DNS nameservers in the Tailscale admin console by hand", gamedns.Zone))
		return
	}
	if len(ns) == 0 || util.Now()-lastSplitSync < splitDNSMS {
		return
	}
	lastSplitSync = util.Now()
	go func() {
		cur, err := tsAPICall("GET", "/tailnet/-/dns/split-dns", nil)
		if err == nil {
			have := []string{}
			if arr, ok := util.Obj(cur)[gamedns.Zone].([]any); ok {
				for _, x := range arr {
					have = append(have, util.JSString(x))
				}
			}
			sort.Strings(have)
			if strings.Join(have, ",") != strings.Join(ns, ",") {
				if _, err = tsAPICall("PATCH", "/tailnet/-/dns/split-dns", map[string]any{gamedns.Zone: ns}); err == nil {
					notes.Log(fmt.Sprintf("split DNS for .%s now points at %s", gamedns.Zone, strings.Join(ns, ", ")))
				}
			}
		}
		if err != nil {
			notes.Note("split-dns", fmt.Sprintf("couldn't sync the .%s split DNS, still retrying: %v", gamedns.Zone, err))
			return
		}
		notes.Clear("split-dns")
	}()
}

func sweepGuests() {
	if tsAPIKey == "" || util.Now()-lastGuestSweep < guestSweepMS {
		return
	}
	lastGuestSweep = util.Now()
	go func() {
		v, err := tsAPICall("GET", "/tailnet/-/devices", nil)
		if err == nil {
			devs, _ := util.Obj(v)["devices"].([]any)
			for _, d := range devs {
				dm := util.Obj(d)
				guest := false
				tags, _ := dm["tags"].([]any)
				for _, t := range tags {
					guest = guest || t == "tag:guest"
				}
				if !guest {
					continue
				}
				created, _ := time.Parse(time.RFC3339, util.JSString(dm["created"]))
				if util.Now()-created.UnixMilli() < guestTTLMS {
					continue
				}
				id := util.Str(dm["nodeId"])
				if id == "" {
					id = util.Str(dm["id"])
				}
				if _, err = tsAPICall("DELETE", "/device/"+id, nil); err != nil {
					break
				}
				notes.Log(fmt.Sprintf("removed guest %s, past 3 days", util.JSString(dm["hostname"])))
			}
		}
		if err != nil {
			notes.Note("guests", "couldn't sweep guest devices, still retrying: "+err.Error())
			return
		}
		notes.Clear("guests")
	}()
}

// --- the tick --------------------------------------------------------------

var (
	devices   = []map[string]any{}
	routes    = []map[string]any{}
	lock      any
	chain     any
	lastOwnFp string
)

// PeerIPs phosphorus peers -> tailnet IP, self left out
func PeerIPs() map[string]string {
	mu.RLock()
	defer mu.RUnlock()
	return peerIPsLocked()
}

func peerIPsLocked() map[string]string {
	out := map[string]string{}
	for _, d := range devices {
		name, _ := d["name"].(string)
		if d["phosphorus"] == true && name != selfHost && ipv4Only(hostIPs[name]) {
			out[name] = hostIPs[name]
		}
	}
	return out
}

func tick() {
	peers, ok := knownPeers()
	mu.RLock()
	ip := selfIP
	mu.RUnlock()
	if ip == "" {
		ip = selfHost
	}
	var wg sync.WaitGroup
	var own []map[string]any
	wg.Add(1)
	go func() { defer wg.Done(); own = services.Refresh(ip) }()
	for _, p := range peers {
		if p.online {
			wg.Add(1)
			go func(p peer) { defer wg.Done(); pollPeer(p) }(p)
		}
	}
	wg.Wait()
	handOn()

	platform := hooks.Platform()
	mu.Lock()
	if ok {
		seen := map[string]bool{}
		for _, p := range peers {
			seen[p.host] = true
		}
		for h := range peerStates {
			if seen[h] {
				continue
			}
			delete(peerStates, h)
			notes.Clear("peer:" + h)
			defer clock.MarkHot()
			notes.Log(h + " left the tailnet")
		}
		next := []map[string]any{}
		if selfHost != "" {
			next = append(next, map[string]any{"name": selfHost, "os": platform, "phosphorus": true, "phosphorusSeen": true})
		}
		for _, p := range peers {
			st := stateFor(p.host)
			if !p.online && st.answered {
				st.answered = false
				st.misses = 0
				retire(st)
				defer clock.MarkHot()
			}
			ph := p.online && st.answered && st.misses < missThreshold
			if !ph && !p.online {
				continue
			}
			d := map[string]any{"name": p.host, "phosphorus": ph, "phosphorusSeen": st.everAnswered}
			if ph {
				d["os"] = st.platform
				d["version"] = st.version
			} else {
				d["os"] = p.os
				d["version"] = ""
			}
			next = append(next, d)
		}
		devices = next
		hostIPs = map[string]string{}
		for _, p := range peers {
			hostIPs[p.host] = p.ip
		}
		if selfHost != "" && selfIP != "" {
			hostIPs[selfHost] = selfIP
		}
		util.NoteTailnetIPs(hostIPs)
		proxy.PinTargets(peerIPsLocked())
	}

	mine := []map[string]any{}
	for _, r := range own {
		x := map[string]any{}
		for k, v := range r {
			x[k] = v
		}
		x["host"] = selfHost
		mine = append(mine, x)
	}
	if fp := string(util.Marshal(mine)); fp != lastOwnFp {
		lastOwnFp = fp
		defer clock.MarkHot()
	}
	merged := append([]map[string]any{}, mine...)
	for h, st := range peerStates {
		for _, e := range st.entries {
			x := map[string]any{}
			for k, v := range e {
				x[k] = v
			}
			x["host"] = h
			merged = append(merged, x)
		}
	}
	sort.SliceStable(merged, func(i, j int) bool {
		hi, _ := merged[i]["host"].(string)
		hj, _ := merged[j]["host"].(string)
		if c := util.LocaleCompare(hi, hj); c != 0 {
			return c < 0
		}
		return util.LocaleCompare(util.JSString(merged[i]["name"]), util.JSString(merged[j]["name"])) < 0
	})
	routes = merged
	ips := map[string]string{}
	for k, v := range hostIPs {
		ips[k] = v
	}
	hosts := make([]string, 0, len(peerStates))
	for h := range peerStates {
		hosts = append(hosts, h)
	}
	sort.Strings(hosts)
	lock = nil
	for _, h := range hosts {
		if st := peerStates[h]; st.lock != nil {
			lock = st.lock
			break
		}
	}
	chain = lock
	if chain == nil {
		var best map[string]any
		for _, h := range hosts {
			c, ok := peerStates[h].chain.(map[string]any)
			if !ok {
				continue
			}
			if best == nil || util.JSString(c["startedAt"]) > util.JSString(best["startedAt"]) {
				best = c
			}
		}
		if best != nil {
			chain = best
		}
	}
	held := lock != nil
	gameIPs = mapGames(merged)
	selfIPNow := selfIP
	livePeers := []sshrelay.Peer{}
	for _, p := range peers {
		livePeers = append(livePeers, sshrelay.Peer{Host: p.host, IP: p.ip})
	}
	live := []string{}
	for _, d := range devices {
		if d["phosphorus"] == true {
			live = append(live, d["name"].(string))
		}
	}
	sort.Strings(live)
	ns := []string{}
	for _, m := range live {
		if ip := hostIPs[m]; ipv4Only(ip) {
			ns = append(ns, ip)
		}
	}
	sort.Strings(ns)
	mu.Unlock()

	proxy.Swap(merged, func(h string) string { return ips[h] })
	if held || hooks.OwnLock() != nil {
		clock.MarkHot()
	}
	gameDNS.Bind(selfIPNow)
	if ok {
		if err := sshrelay.WriteConfig(sshConfigFile, livePeers); err != nil {
			notes.Note("ssh-config", fmt.Sprintf("can't write %s: %v", sshConfigFile, err))
		} else {
			notes.Clear("ssh-config")
		}
	}
	if selfHost != "" && len(live) > 0 && live[0] == selfHost {
		syncSplitDNS(ns)
		sweepGuests()
	}
}

// Start the loop, each round done before the next is timed
func Start(h Hooks) {
	if h.MergeChat != nil {
		hooks.MergeChat = h.MergeChat
	}
	if h.MergePresence != nil {
		hooks.MergePresence = h.MergePresence
	}
	if h.Platform != nil {
		hooks.Platform = h.Platform
	}
	if h.OwnLock != nil {
		hooks.OwnLock = h.OwnLock
	}
	if h.HostServices != nil {
		hooks.HostServices = h.HostServices
	}
	gameDNS = gamedns.New(func(name string) string {
		mu.RLock()
		defer mu.RUnlock()
		return gameIPs[name]
	}, notes.Note)
	if selfHost != "" {
		util.WriteFileAtomic(selfHostFile, []byte(selfHost))
	}
	clock.MarkHot()
	notes.Log(fmt.Sprintf("polling every online tailnet peer every %dms while the mesh is busy, every %dms once it is quiet", clock.FastMS, clock.IdleMS))
	go func() {
		for {
			func() {
				defer func() {
					if r := recover(); r != nil {
						notes.Note("tick", fmt.Sprintf("tick failed, still retrying: %v", r))
					}
				}()
				tick()
				notes.Clear("tick")
			}()
			time.Sleep(clock.Interval())
		}
	}()
}

// Routes the merged service rows
func Routes() []map[string]any {
	mu.RLock()
	defer mu.RUnlock()
	return routes
}

// Tailnet every device as the update pane lists them
func Tailnet() []map[string]any {
	mu.RLock()
	defer mu.RUnlock()
	return devices
}

// Lock a peer's running update chain
func Lock() any {
	mu.RLock()
	defer mu.RUnlock()
	return lock
}

// Chain the live walk, else the newest finished one
func Chain() any {
	mu.RLock()
	defer mu.RUnlock()
	return chain
}

func answeredWithin(st *peerState, ms int64) bool { return util.Now()-st.answeredAt <= ms }

// PeerGit answered within the git max age
func PeerGit() []any {
	mu.RLock()
	defer mu.RUnlock()
	out := []any{}
	for _, h := range sortedHosts() {
		st := peerStates[h]
		if answeredWithin(st, gitMaxAgeMS) && st.git != nil {
			out = append(out, st.git)
		}
	}
	return out
}

// PeerModel answered within the model max age
func PeerModel() []any {
	mu.RLock()
	defer mu.RUnlock()
	out := []any{}
	for _, h := range sortedHosts() {
		st := peerStates[h]
		if answeredWithin(st, modelMaxAgeMS) && st.model != nil {
			out = append(out, st.model)
		}
	}
	return out
}

// PeerSys each answering peer's sys digest
func PeerSys() []struct{ Host, Digest string } {
	mu.RLock()
	defer mu.RUnlock()
	out := []struct{ Host, Digest string }{}
	for _, h := range sortedHosts() {
		st := peerStates[h]
		if st.sys != "" && st.answered {
			out = append(out, struct{ Host, Digest string }{h, st.sys})
		}
	}
	return out
}

// PeerProjects the orangutan's projects on each answering peer
func PeerProjects() []any {
	mu.RLock()
	defer mu.RUnlock()
	out := []any{}
	for _, h := range sortedHosts() {
		out = append(out, peerStates[h].projects...)
	}
	return out
}

func sortedHosts() []string {
	hs := make([]string, 0, len(peerStates))
	for h := range peerStates {
		hs = append(hs, h)
	}
	sort.Strings(hs)
	return hs
}
