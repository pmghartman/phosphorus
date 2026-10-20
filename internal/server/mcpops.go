package server

// the mesh tools' host operations: health, power, terminals, run
// here or on a peer through /internal/op, every peer call carrying a sealed grant

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/pmghartman/phosphorus/internal/cli"
	"github.com/pmghartman/phosphorus/internal/mcp"
	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/services"
	"github.com/pmghartman/phosphorus/internal/term"
	"github.com/pmghartman/phosphorus/internal/update"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
)

// opOn op here when host is this one, else on the peer, the grant sealed for it
func opOn(host, op string, p map[string]any, wait time.Duration) (int, any) {
	if host == selfHost {
		return localOp(op, p)
	}
	grant := users.SealGrant(map[string]any{"op": op, "p": p}, int64(wait/time.Millisecond)+30000)
	st, b := onHost(host, "/internal/op", map[string]any{"grant": grant}, wait)
	// a peer's raw JSON decoded, so callers can read its fields
	if r, ok := b.(json.RawMessage); ok {
		b = util.Decode(r)
	}
	return st, b
}

// peerOp an /internal/op body opened and run
func peerOp(body map[string]any) (int, any) {
	g := users.OpenGrant(str(body["grant"]))
	if g == nil {
		return 403, map[string]any{"error": "bad grant"}
	}
	return localOp(str(g["op"]), util.Obj(g["p"]))
}

func localOp(op string, p map[string]any) (int, any) {
	switch op {
	case "health":
		return 200, localHealth()
	case "power":
		return hostPower(str(p["action"]))
	case "term_close":
		if err := term.Close(str(p["by"]), str(p["id"])); err != nil {
			return 404, map[string]any{"error": err.Error()}
		}
		return 200, map[string]any{"closed": p["id"]}
	case "exec":
		return localExec(str(p["user"]), str(p["pass"]), str(p["cmd"]), str(p["stdin"]), int(num(p["timeout"])))
	case "shell":
		return shellExec(str(p["user"]), str(p["pass"]), str(p["cmd"]), str(p["stdin"]), int(num(p["timeout"])), p["reset"] == true)
	case "mcp_calls":
		return 200, mcp.Calls(str(p["user"]))
	case "service_health":
		ip := util.TailnetIP(selfHost)
		if ip == "" {
			ip = "127.0.0.1"
		}
		h := services.Health(str(p["name"]), ip)
		if h == nil {
			return 404, map[string]any{"error": selfHost + " declares no service " + str(p["name"])}
		}
		h["host"] = selfHost
		return 200, h
	}
	return 400, map[string]any{"error": "no op " + op}
}

var tunnelClient = &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil}}

// localHealth this host's tunnel as cloudflared's /ready says, and its frontend
func localHealth() map[string]any {
	tunnel := map[string]any{"state": "off", "why": "no TUNNEL_TOKEN, tailnet only"}
	if os.Getenv("TUNNEL_TOKEN") != "" {
		tunnel = map[string]any{"state": "down", "why": "cloudflared's metrics not answering on " + util.TunnelMetrics}
		if res, err := tunnelClient.Get("http://" + util.TunnelMetrics + "/ready"); err == nil {
			var r map[string]any
			json.NewDecoder(res.Body).Decode(&r)
			res.Body.Close()
			n := num(r["readyConnections"])
			tunnel = map[string]any{"state": "up", "connections": n}
			if res.StatusCode != 200 || n == 0 {
				tunnel = map[string]any{"state": "down", "connections": n, "why": "no edge connection ready"}
			}
		}
	}
	return map[string]any{"host": selfHost, "version": Version(), "tunnel": tunnel, "uptimeSec": int(time.Since(started).Seconds())}
}

var started = time.Now()

// meshHealth every phosphorus host's health, with its round trip from here
func meshHealth() []any {
	hosts := []string{selfHost}
	for _, d := range mesh.Tailnet() {
		if n := str(d["name"]); n != selfHost && (d["phosphorus"] == true || d["phosphorusSeen"] == true) {
			hosts = append(hosts, n)
		}
	}
	out := make([]any, len(hosts))
	var wg sync.WaitGroup
	for i, h := range hosts {
		wg.Add(1)
		go func(i int, h string) {
			defer wg.Done()
			t0 := time.Now()
			st, b := opOn(h, "health", nil, 8*time.Second)
			row := map[string]any{"host": h}
			if st >= 300 {
				row["answering"] = false
				row["error"] = str(util.Obj(b)["error"])
			} else {
				for k, v := range util.Obj(b) {
					row[k] = v
				}
				row["answering"] = true
				row["rttMs"] = time.Since(t0).Milliseconds()
			}
			out[i] = row
		}(i, h)
	}
	wg.Wait()
	return out
}

// hostPower phosphorus restarted, or the machine rebooted, both detached and
// a moment late so this answer gets out first
func hostPower(action string) (int, any) {
	var c *exec.Cmd
	switch action {
	case "restart":
		c = exec.Command(binSelf(), "restart", "--home", util.RepoDir)
	case "reboot":
		switch runtime.GOOS {
		case "windows":
			c = exec.Command("shutdown", "/r", "/t", "5", "/c", "phosphorus: reboot asked over the mesh")
		default:
			c = exec.Command("sh", "-c", "sleep 3; shutdown -r now")
		}
	default:
		return 400, map[string]any{"error": "action is restart or reboot"}
	}
	if err := cli.StartDetached(c, 2*time.Second); err != nil {
		return 500, map[string]any{"error": err.Error()}
	}
	return 202, map[string]any{"host": selfHost, "action": action, "note": "under way, the host drops off the mesh and comes back"}
}

// binSelf the installed phosphorus binary, else this one
func binSelf() string {
	name := "phosphorus"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if p := filepath.Join(util.RepoDir, "bin", name); fileExists(p) {
		return p
	}
	p, _ := os.Executable()
	return p
}

const historyMax = 50

func historyFile() string { return filepath.Join(stateDir, "update-history.json") }

var historyMu sync.Mutex

// rememberChain a finished chain kept, the last fifty, newest last
func rememberChain(c *update.Chain) {
	historyMu.Lock()
	defer historyMu.Unlock()
	var all []any
	if b, err := os.ReadFile(historyFile()); err == nil {
		json.Unmarshal(b, &all)
	}
	all = append(all, map[string]any{"id": c.ID, "startedAt": c.StartedAt, "finishedAt": c.FinishedAt, "order": c.Order,
		"results": c.Results, "errors": c.Errors, "details": c.Details, "versions": c.Versions, "cancelled": c.Cancelled, "by": selfHost})
	if len(all) > historyMax {
		all = all[len(all)-historyMax:]
	}
	util.WriteJSONAtomic(historyFile(), all)
}

// chainHistory the chains started here, newest last
func chainHistory() any {
	historyMu.Lock()
	defer historyMu.Unlock()
	all := []any{}
	if b, err := os.ReadFile(historyFile()); err == nil {
		json.Unmarshal(b, &all)
	}
	return map[string]any{"host": selfHost, "note": "chains started from this host; another host keeps its own", "chains": all}
}

const (
	execMax    = 600
	execOutMax = 256 << 10
)

// capped a writer keeping the first n bytes, the rest only marked cut
type capped struct {
	b   bytes.Buffer
	n   int
	cut bool
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.n - c.b.Len(); room > 0 {
		c.b.Write(p[:min(room, len(p))])
	}
	if c.b.Len() >= c.n {
		c.cut = true
	}
	return len(p), nil
}

// localExec one command as user over this host's own sshd, no pty, stdin fed
// it: its exit code, stdout and stderr; killed past timeout seconds
func localExec(user, pass, cmd, stdin string, timeout int) (int, any) {
	if user == "" || strings.TrimSpace(cmd) == "" {
		return 400, map[string]any{"error": "a login and a command"}
	}
	if timeout < 1 || timeout > execMax {
		timeout = 60
	}
	cfg := &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{ssh.Password(pass), ssh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
			out := make([]string, len(qs))
			for i := range out {
				out[i] = pass
			}
			return out, nil
		})},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}
	c, err := ssh.Dial("tcp", net.JoinHostPort(hostSSHHost, hostSSHPort), cfg)
	if err != nil {
		if strings.Contains(err.Error(), "unable to authenticate") {
			return 403, map[string]any{"error": "the saved login for " + selfHost + " was refused"}
		}
		return 502, map[string]any{"error": "ssh to " + selfHost + ": " + err.Error()}
	}
	defer c.Close()
	ss, err := c.NewSession()
	if err != nil {
		return 502, map[string]any{"error": err.Error()}
	}
	defer ss.Close()
	stdout, stderr := &capped{n: execOutMax}, &capped{n: execOutMax}
	ss.Stdout, ss.Stderr = stdout, stderr
	if stdin != "" {
		ss.Stdin = strings.NewReader(stdin)
	}
	t0 := time.Now()
	done := make(chan error, 1)
	go func() { done <- ss.Run(cmd) }()
	code, timedOut := 0, false
	select {
	case err = <-done:
	case <-time.After(time.Duration(timeout) * time.Second):
		ss.Signal(ssh.SIGKILL)
		c.Close()
		timedOut = true
	}
	if ee, ok := err.(*ssh.ExitError); ok {
		code = ee.ExitStatus()
	} else if err != nil && !timedOut {
		code = -1
		stderr.Write([]byte(err.Error()))
	}
	out := map[string]any{"host": selfHost, "user": user, "exit": code, "stdout": util.UTF8(stdout.b.Bytes()),
		"stderr": util.UTF8(stderr.b.Bytes()), "ms": time.Since(t0).Milliseconds()}
	if timedOut {
		out["exit"], out["timedOut"] = nil, true
	}
	if stdout.cut || stderr.cut {
		out["truncated"] = true
	}
	return 200, out
}

// mcpCallsMesh a user's agent calls from every host, a connector reaching
// whichever one its ingress picks: in flight from all, the recent merged newest first
// skewTimes a peer's call log shifted by d ms, its zero times left zero
func skewTimes(c map[string]any, d float64) {
	if d == 0 || num(c["now"]) == 0 {
		return
	}
	shift := func(m map[string]any, k string) {
		if v := num(m[k]); v != 0 {
			m[k] = v + d
		}
	}
	shift(c, "seen")
	shift(c, "at")
	for _, k := range []string{"calls", "recent"} {
		l, _ := c[k].([]any)
		for _, x := range l {
			if m := util.Obj(x); m != nil {
				shift(m, "since")
				shift(m, "at")
			}
		}
	}
}

func mcpCallsMesh(user string) map[string]any {
	out := mcp.Calls(user)
	hosts := []string{}
	for h := range mesh.PeerIPs() {
		hosts = append(hosts, h)
	}
	got := make([]map[string]any, len(hosts))
	var wg sync.WaitGroup
	for i, h := range hosts {
		wg.Add(1)
		go func(i int, h string) {
			defer wg.Done()
			if st, b := opOn(h, "mcp_calls", map[string]any{"user": user}, 2500*time.Millisecond); st < 300 {
				got[i] = util.Obj(b)
			}
		}(i, h)
	}
	wg.Wait()
	calls, _ := out["calls"].([]any)
	recent, _ := out["recent"].([]any)
	seen := num(out["seen"])
	for _, c := range got {
		if c == nil {
			continue
		}
		// a peer's times onto this host's clock
		skewTimes(c, num(out["now"])-num(c["now"]))
		if l, ok := c["calls"].([]any); ok {
			calls = append(calls, l...)
		}
		if l, ok := c["recent"].([]any); ok {
			recent = append(recent, l...)
		}
		if num(c["at"]) > num(out["at"]) {
			out["at"] = c["at"]
		}
		// the agent named by the host that heard it last
		if s := num(c["seen"]); s > seen {
			seen = s
			out["seen"] = c["seen"]
			if str(c["client"]) != "" {
				out["client"] = c["client"]
			}
		}
	}
	sort.SliceStable(recent, func(i, j int) bool { return num(util.Obj(recent[i])["at"]) > num(util.Obj(recent[j])["at"]) })
	if len(recent) > 40 {
		recent = recent[:40]
	}
	sort.SliceStable(calls, func(i, j int) bool { return num(util.Obj(calls[i])["since"]) < num(util.Obj(calls[j])["since"]) })
	out["calls"], out["recent"] = calls, recent
	return out
}
