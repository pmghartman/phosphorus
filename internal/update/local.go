package update

// this host's own update, and a peer's followed to its end

import (
	"crypto/rand"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/clock"
	"github.com/pmghartman/phosphorus/internal/util"
)

type result struct {
	ok          bool
	current     bool
	to          string
	error       string
	unreachable bool
}

var failedHook = func() {}

// OnFailed server's, for an update here that ended without a new release
func OnFailed(fn func()) { failedHook = fn }

func uuid() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// UUID a random v4 id
func UUID() string { return uuid() }

// the host's agent (the systemd path unit, the app) answers a request through
// agentFile: the request's id, then running, ok or failed
func readAgent() map[string]any { return util.ReadJSONMap(agentFile) }

// a verdict from an agent's or a peer's status: ok or an error, neither while running
func verdict(a map[string]any) result {
	switch a["state"] {
	case "ok":
		to := util.Str(a["version"])
		if to == "" {
			to = ReadVersion(VersionFile)
		}
		return result{ok: true, current: util.Truthy(a["current"]), to: to}
	case "failed":
		e := util.Str(a["error"])
		if e == "" {
			e = "update failed"
		}
		if len(e) > 500 {
			e = e[:500]
		}
		return result{error: e}
	}
	return result{}
}

func (r result) settled() bool { return r.ok || r.error != "" }

// Request one update here, shared by everyone who asks while it runs
type Request struct {
	ID   string
	done chan struct{}
	res  result
}

var (
	localMu  sync.Mutex
	inFlight *Request
)

// Ask hands an update to this host's agent, or joins the one already running
func Ask() (*Request, error) {
	localMu.Lock()
	defer localMu.Unlock()
	if inFlight != nil {
		return inFlight, nil
	}
	q := &Request{ID: uuid(), done: make(chan struct{})}
	if err := util.WriteJSONAtomic(requestFile, map[string]any{"id": q.ID, "at": util.Now()}); err != nil {
		return nil, fmt.Errorf("couldn't request the update: %w", err)
	}
	inFlight = q
	go func() {
		q.res = awaitAgent(q.ID)
		localMu.Lock()
		inFlight = nil
		localMu.Unlock()
		close(q.done)
		if !q.res.ok {
			failedHook()
		}
	}()
	return q, nil
}

// wait for the verdict
func (q *Request) wait() result {
	<-q.done
	return q.res
}

// awaitAgent the agent's verdict on a request, an unanswered one withdrawn
func awaitAgent(id string) result {
	started := util.Now()
	for util.Now()-started < updateTimeoutMS {
		pause()
		a := readAgent()
		if a == nil || a["id"] != id {
			if util.Now()-started > agentPickupMS {
				if _, err := os.Stat(requestFile); err == nil {
					os.Remove(requestFile)
					return result{error: "no update agent on this host: reinstall from the latest release"}
				}
			}
			continue
		}
		if r := verdict(a); r.settled() {
			return r
		}
	}
	return result{error: "update timed out"}
}

// Status this host's update as its peers read it: the request in flight, else
// the agent's last word
func Status() map[string]any {
	a := readAgent()
	localMu.Lock()
	q := inFlight
	localMu.Unlock()
	if q != nil && (a == nil || a["id"] != q.ID) {
		return map[string]any{"id": q.ID, "state": "asked"}
	}
	if a == nil {
		return map[string]any{"state": "idle"}
	}
	return map[string]any{"id": a["id"], "state": a["state"], "current": util.Truthy(a["current"]), "version": a["version"], "error": a["error"]}
}

// Busy while an update here is asked for or running
func Busy() bool {
	s := Status()["state"]
	return s == "asked" || s == "running"
}

// settleSelf this host's update after its own restart: the agent's verdict on
// the request the chain made, never assumed from the restart alone
func settleSelf(id string) result {
	if id == "" {
		return result{error: "restarted before the update was asked for"}
	}
	for until := util.Now() + peerQuietMS; util.Now() < until; pause() {
		if a := readAgent(); a != nil && a["id"] == id {
			if r := verdict(a); r.settled() {
				return r
			}
		}
	}
	return result{error: "the update never finished after this host restarted"}
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

type selfInfo struct{ bootID, version, platform string }

// a peer's pace and eyes, swapped for fakes in tests
var (
	pause     = func() { time.Sleep(clock.Interval()) }
	askPeer   = askPeerHTTP
	peerState = peerStateHTTP
	peerSelf  = peerSelfHTTP
)

// askPeerHTTP a peer's update asked for: the id to follow it by
func askPeerHTTP(host string) (string, result) {
	r, err := peerReq(host, util.Req{Method: "POST", Path: "/api/update/local", Body: map[string]any{}, ConnectTimeout: connectTimeout})
	if err != nil {
		return "", result{unreachable: true, error: err.Error()}
	}
	m := util.Obj(util.Decode(r.Body))
	if r.Status == 202 {
		if id := util.Str(m["id"]); id != "" {
			return id, result{}
		}
		return "", result{error: "the host didn't name its update"}
	}
	e := fmt.Sprintf("status %d", r.Status)
	if m != nil && util.Truthy(m["error"]) {
		e = util.JSString(m["error"])
	}
	if len(e) > 500 {
		e = e[:500]
	}
	return "", result{error: e}
}

func peerStateHTTP(host string) (map[string]any, error) {
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

func peerSelfHTTP(host string) selfInfo {
	r, err := peerReq(host, util.Req{Path: "/api/mesh/snapshot"})
	if err != nil {
		return selfInfo{}
	}
	s := util.Obj(util.Obj(util.Decode(r.Body))["self"])
	return selfInfo{util.Str(s["bootId"]), util.Str(s["version"]), util.Str(s["platform"])}
}

var peerAddr = func(host string) string {
	if a := util.TailnetIP(host); a != "" {
		return a
	}
	return host
}

// callPeerUpdate a peer's update asked for and followed, its id and boot noted
// so a watch picked up after this host restarts goes on
func callPeerUpdate(host string, note func(map[string]string)) result {
	addr := peerAddr(host)
	before := peerSelf(addr)
	id, r := askPeer(addr)
	if id == "" {
		return r
	}
	note(map[string]string{"from": before.version, "boot": before.bootID, "id": id})
	return watchPeer(host, id, before.version, before.bootID, "asked", note)
}

// watchPeer a peer's update, found by its id, followed to its verdict: its
// agent's, then its new boot
func watchPeer(host, id, fromVersion, fromBoot, stage string, note func(map[string]string)) result {
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
		pause()
		status, err := peerState(addr)
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
		if status["id"] != id {
			continue
		}
		if swapDeadline != 0 && util.Now() > swapDeadline {
			return result{error: "the restart never landed, see that host's phosphorus log"}
		}
		if status["state"] == "running" && stage == "asked" {
			at("installing")
		}
		v := verdict(status)
		if !v.settled() {
			continue
		}
		if !v.ok || v.current {
			if v.current {
				v.to = fromVersion
			}
			return v
		}
		after := peerSelf(addr)
		if fromBoot == "" || (after.bootID != "" && after.bootID != fromBoot) {
			if after.version != "" {
				v.to = after.version
			}
			return v
		}
		at("restarting")
		if swapDeadline == 0 {
			swapDeadline = util.Now() + swapTimeoutMS
		}
	}
	return result{unreachable: true, error: "gave up waiting for the update to finish"}
}
