package update

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

// a fresh state dir, quick polling, this host named a
func setup(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	requestFile = filepath.Join(dir, "update-request.json")
	agentFile = filepath.Join(dir, "update-agent.json")
	chainFile = filepath.Join(dir, "update-chain.json")
	VersionFile = filepath.Join(dir, "VERSION")
	os.WriteFile(VersionFile, []byte("1.0\n"), 0o644)
	selfHost = "a"
	pause = func() { time.Sleep(time.Millisecond) }
	peerAddr = func(h string) string { return h }
	startGraceMS = 200
	chain, inFlight = nil, nil
	failedHook = func() {}
	finishHook = func(*Chain) {}
	t.Cleanup(func() {
		chain, inFlight = nil, nil
		failedHook = func() {}
		finishHook = func(*Chain) {}
	})
}

func agent(t *testing.T, id, state, version, err string, current bool) {
	t.Helper()
	util.WriteJSONAtomic(agentFile, map[string]any{"id": id, "state": state, "version": version, "error": err, "current": current})
}

func within(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out: %s", what)
}

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"0.14", "0.13.1", true}, {"0.13.1", "0.13", true}, {"0.13", "0.13.1", false},
		{"1.0", "1.0", false}, {"1.0.0", "1.0", false}, {"2", "10", false}, {"1.10", "1.9", true},
	} {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestAskJoinsTheUpdateInFlight(t *testing.T) {
	setup(t)
	q1, err := Ask()
	if err != nil {
		t.Fatal(err)
	}
	q2, _ := Ask()
	if q1 != q2 {
		t.Fatal("a second ask started a second update")
	}
	if s := Status(); s["state"] != "asked" || s["id"] != q1.ID {
		t.Fatalf("status before pickup = %v", s)
	}
	agent(t, q1.ID, "running", "", "", false)
	if s := Status(); s["state"] != "running" {
		t.Fatalf("status while running = %v", s)
	}
	if !Busy() {
		t.Fatal("not busy while running")
	}
	agent(t, q1.ID, "ok", "1.1", "", false)
	if r := q1.wait(); !r.ok || r.to != "1.1" || r.current {
		t.Fatalf("verdict = %+v", r)
	}
	within(t, "request cleared", func() bool { localMu.Lock(); defer localMu.Unlock(); return inFlight == nil })
	q3, _ := Ask()
	if q3 == q1 {
		t.Fatal("a finished update was joined")
	}
}

func TestAskIgnoresAnotherRequestsVerdict(t *testing.T) {
	setup(t)
	agent(t, "stale", "ok", "0.9", "", false)
	q, _ := Ask()
	select {
	case <-q.done:
		t.Fatal("settled on a verdict for another id")
	case <-time.After(50 * time.Millisecond):
	}
	agent(t, q.ID, "failed", "", "apt broke", false)
	if r := q.wait(); r.ok || r.error != "apt broke" {
		t.Fatalf("verdict = %+v", r)
	}
}

func TestAskFailureTellsTheServer(t *testing.T) {
	setup(t)
	var failed atomic.Bool
	failedHook = func() { failed.Store(true) }
	q, _ := Ask()
	agent(t, q.ID, "failed", "", "", false)
	if r := q.wait(); r.error != "update failed" {
		t.Fatalf("verdict = %+v", r)
	}
	within(t, "failure hook", failed.Load)
}

func TestStatusIdle(t *testing.T) {
	setup(t)
	if s := Status(); s["state"] != "idle" || Busy() {
		t.Fatalf("status = %v", s)
	}
}

func TestSettleSelf(t *testing.T) {
	setup(t)
	if r := settleSelf(""); r.ok || r.error == "" {
		t.Fatalf("a restart with no request settled as %+v", r)
	}
	agent(t, "x", "ok", "1.1", "", false)
	if r := settleSelf("x"); !r.ok || r.to != "1.1" {
		t.Fatalf("verdict = %+v", r)
	}
	agent(t, "y", "failed", "", "build failed", false)
	if r := settleSelf("y"); r.ok || r.error != "build failed" {
		t.Fatalf("verdict = %+v", r)
	}
}

// a peer's status and self snapshots, scripted
type fakePeer struct {
	states []map[string]any
	i      int
	boots  []string
	b      int
}

func (f *fakePeer) state(string) (map[string]any, error) {
	s := f.states[min(f.i, len(f.states)-1)]
	f.i++
	return s, nil
}

func (f *fakePeer) self(string) selfInfo {
	b := f.boots[min(f.b, len(f.boots)-1)]
	f.b++
	return selfInfo{bootID: b, version: "1.1"}
}

func watch(t *testing.T, f *fakePeer, id, boot string) (result, []string) {
	t.Helper()
	setup(t)
	peerState, peerSelf = f.state, f.self
	t.Cleanup(func() { peerState, peerSelf = peerStateHTTP, peerSelfHTTP })
	var stages []string
	r := watchPeer("p", id, "1.0", boot, "asked", func(m map[string]string) {
		if s, ok := m["stage"]; ok {
			stages = append(stages, s)
		}
	})
	return r, stages
}

func st(id, state string) map[string]any {
	return map[string]any{"id": id, "state": state}
}

func TestWatchPeerSucceedsOnTheNewBoot(t *testing.T) {
	f := &fakePeer{
		states: []map[string]any{st("old", "ok"), st("u1", "asked"), st("u1", "running"), st("u1", "ok")},
		boots:  []string{"boot1", "boot2"},
	}
	r, stages := watch(t, f, "u1", "boot1")
	if !r.ok || r.to != "1.1" {
		t.Fatalf("verdict = %+v", r)
	}
	if len(stages) < 2 || stages[0] != "asked" || stages[1] != "installing" {
		t.Fatalf("stages = %v, want asked then installing", stages)
	}
}

func TestWatchPeerIgnoresAnotherUpdatesVerdict(t *testing.T) {
	f := &fakePeer{states: []map[string]any{st("other", "failed"), st("u1", "failed")}, boots: []string{"b"}}
	f.states[1]["error"] = "pull failed"
	if r, _ := watch(t, f, "u1", "b"); r.ok || r.error != "pull failed" {
		t.Fatalf("verdict = %+v", r)
	}
}

func TestWatchPeerAlreadyCurrent(t *testing.T) {
	cur := st("u1", "ok")
	cur["current"] = true
	r, _ := watch(t, &fakePeer{states: []map[string]any{cur}, boots: []string{"b"}}, "u1", "b")
	if !r.ok || !r.current || r.to != "1.0" {
		t.Fatalf("verdict = %+v", r)
	}
}

func TestWatchPeerOkWithoutARestartWaits(t *testing.T) {
	// ok, but the boot never changes: not a success until the swap deadline
	f := &fakePeer{states: []map[string]any{st("u1", "ok")}, boots: []string{"b"}}
	setup(t)
	peerState, peerSelf = f.state, f.self
	t.Cleanup(func() { peerState, peerSelf = peerStateHTTP, peerSelfHTTP })
	done := make(chan result, 1)
	go func() { done <- watchPeer("p", "u1", "1.0", "b", "asked", func(map[string]string) {}) }()
	select {
	case r := <-done:
		t.Fatalf("settled without a restart: %+v", r)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestCallPeerUpdate(t *testing.T) {
	f := &fakePeer{states: []map[string]any{st("u9", "ok")}, boots: []string{"b1", "b2"}}
	setup(t)
	peerState, peerSelf = f.state, f.self
	askPeer = func(string) (string, result) { return "u9", result{} }
	t.Cleanup(func() { peerState, peerSelf, askPeer = peerStateHTTP, peerSelfHTTP, askPeerHTTP })
	var got map[string]string
	r := callPeerUpdate("p", func(m map[string]string) {
		if m["id"] != "" {
			got = m
		}
	})
	if !r.ok {
		t.Fatalf("verdict = %+v", r)
	}
	if got["id"] != "u9" || got["boot"] != "b1" || got["from"] != "1.1" {
		t.Fatalf("noted %v", got)
	}
	askPeer = func(string) (string, result) { return "", result{unreachable: true, error: "no route"} }
	if r := callPeerUpdate("p", func(map[string]string) {}); r.ok || !r.unreachable {
		t.Fatalf("an unreachable ask gave %+v", r)
	}
}

func TestBrief(t *testing.T) {
	for _, c := range []struct {
		r    result
		want string
	}{
		{result{error: "pull failed: x"}, "pull failed"}, {result{error: "the restart never landed"}, "restart failed"},
		{result{error: "update timed out"}, "timed out"}, {result{unreachable: true, error: "x"}, "unreachable"},
		{result{error: "x"}, "failed"},
	} {
		if got := brief(c.r); got != c.want {
			t.Errorf("brief(%+v) = %q, want %q", c.r, got, c.want)
		}
	}
}

func savedChain(results map[string]string, versions map[string]map[string]string) Chain {
	order := []string{}
	for h := range results {
		order = append(order, h)
	}
	return Chain{ID: "00000000-0000", Order: order, Results: results, Versions: versions, Errors: map[string]string{}, SavedAt: util.Now()}
}

func restored(t *testing.T, c Chain) *Chain {
	t.Helper()
	util.WriteJSONAtomic(chainFile, c)
	done := make(chan *Chain, 1)
	finishHook = func(c *Chain) { done <- c }
	RestoreChain()
	select {
	case c := <-done:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("restored chain never finished")
		return nil
	}
}

func TestRestoreTakesThisHostsVerdictFromItsAgent(t *testing.T) {
	setup(t)
	agent(t, "u1", "ok", "1.1", "", false)
	c := restored(t, savedChain(map[string]string{"a": "running"}, map[string]map[string]string{"a": {"id": "u1", "from": "1.0"}}))
	if c.Results["a"] != "ok" || !c.Done {
		t.Fatalf("chain = %+v", c)
	}
}

func TestRestoreNeverAssumesASuccess(t *testing.T) {
	setup(t)
	// a restart with no request on record is a failure, not an update
	c := restored(t, savedChain(map[string]string{"a": "running"}, map[string]map[string]string{"a": {"from": "1.0"}}))
	if c.Results["a"] != "fail" || c.Errors["a"] == "" {
		t.Fatalf("chain = %+v", c)
	}
	setup(t)
	agent(t, "u1", "failed", "", "install failed", false)
	c = restored(t, savedChain(map[string]string{"a": "running"}, map[string]map[string]string{"a": {"id": "u1"}}))
	if c.Results["a"] != "fail" || c.Details["a"] != "install failed" {
		t.Fatalf("chain = %+v", c)
	}
}

func TestRestoreWatchesPeersAgain(t *testing.T) {
	setup(t)
	f := &fakePeer{states: []map[string]any{st("p1", "ok")}, boots: []string{"new"}}
	peerState, peerSelf = f.state, f.self
	t.Cleanup(func() { peerState, peerSelf = peerStateHTTP, peerSelfHTTP })
	agent(t, "u1", "ok", "1.1", "", false)
	c := restored(t, savedChain(
		map[string]string{"a": "running", "p": "running", "q": "ok"},
		map[string]map[string]string{"a": {"id": "u1"}, "p": {"id": "p1", "boot": "old", "from": "1.0", "stage": "installing"}},
	))
	if c.Results["a"] != "ok" || c.Results["p"] != "ok" || c.Results["q"] != "ok" {
		t.Fatalf("results = %v", c.Results)
	}
}

func TestRestoreLeavesFinishedAndStaleChainsAlone(t *testing.T) {
	setup(t)
	done := savedChain(map[string]string{"a": "ok"}, nil)
	done.Done = true
	util.WriteJSONAtomic(chainFile, done)
	RestoreChain()
	stale := savedChain(map[string]string{"a": "running"}, nil)
	stale.SavedAt = util.Now() - chainMaxAgeMS - 1000
	util.WriteJSONAtomic(chainFile, stale)
	RestoreChain()
	if chain != nil {
		t.Fatalf("restored %+v", chain)
	}
}

func TestRestoreFinishesWhenNothingIsRunning(t *testing.T) {
	setup(t)
	c := restored(t, savedChain(map[string]string{"a": "ok", "b": "pending"}, nil))
	if c.Results["b"] != "skipped" || !c.Done {
		t.Fatalf("chain = %+v", c)
	}
}

func TestStartAndCancelInTheGrace(t *testing.T) {
	setup(t)
	done := make(chan *Chain, 1)
	finishHook = func(c *Chain) { done <- c }
	r := Start(nil, nil)
	if r["chainId"] == nil {
		t.Fatalf("start = %v", r)
	}
	if held := Start(nil, nil); held["locked"] != "a" {
		t.Fatalf("a second start got %v", held)
	}
	if ChainStatus() == nil || OwnLock() == nil {
		t.Fatal("no chain published while one runs")
	}
	if !Cancel() {
		t.Fatal("cancel refused")
	}
	select {
	case c := <-done:
		if !c.Cancelled || c.Results["a"] != "skipped" {
			t.Fatalf("chain = %+v", c)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled chain never finished")
	}
	if Cancel() {
		t.Fatal("cancelled a finished chain")
	}
	if OwnLock() != nil {
		t.Fatal("a finished chain still holds the lock")
	}
}

func TestStartOverOnlyTheNamedHosts(t *testing.T) {
	setup(t)
	if r := Start(nil, []string{"nowhere"}); r["error"] == nil {
		t.Fatalf("start = %v", r)
	}
}
