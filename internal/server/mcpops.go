package server

// the mesh tools' host operations: health, power, containers, terminals, run
// here or on a peer through /internal/op, every peer call carrying a sealed grant

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/pmghartman/phosphorus/internal/cli"
	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/services"
	"github.com/pmghartman/phosphorus/internal/term"
	"github.com/pmghartman/phosphorus/internal/update"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
)

var containerRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// opOn op here when host is this one, else on the peer, the grant sealed for it
func opOn(host, op string, p map[string]any, wait time.Duration) (int, any) {
	if host == selfHost {
		return localOp(op, p)
	}
	grant := users.SealGrant(map[string]any{"op": op, "p": p}, int64(wait/time.Millisecond)+30000)
	return onHost(host, "/internal/op", map[string]any{"grant": grant}, wait)
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
	case "containers":
		return containerList()
	case "container":
		return containerAct(str(p["name"]), str(p["action"]))
	case "term_close":
		if err := term.Close(str(p["by"]), str(p["id"])); err != nil {
			return 404, map[string]any{"error": err.Error()}
		}
		return 200, map[string]any{"closed": p["id"]}
	case "exec":
		return localExec(str(p["user"]), str(p["pass"]), str(p["cmd"]), str(p["stdin"]), int(num(p["timeout"])))
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

func docker(wait time.Duration, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker %s: %s", args[0], strings.TrimSpace(string(out)+" "+err.Error()))
	}
	return out, nil
}

// containerList docker's containers here, running or not
func containerList() (int, any) {
	b, err := docker(15*time.Second, "ps", "-a", "--format", "{{json .}}")
	if err != nil {
		return 503, map[string]any{"error": err.Error()}
	}
	out := []any{}
	for _, l := range splitLines(string(b)) {
		var r map[string]any
		if json.Unmarshal([]byte(l), &r) == nil {
			out = append(out, map[string]any{"name": r["Names"], "image": r["Image"], "state": r["State"], "status": r["Status"], "ports": r["Ports"]})
		}
	}
	return 200, map[string]any{"host": selfHost, "containers": out}
}

func containerAct(name, action string) (int, any) {
	if !containerRe.MatchString(name) {
		return 400, map[string]any{"error": "bad container name"}
	}
	if action != "start" && action != "stop" && action != "restart" {
		return 400, map[string]any{"error": "action is start, stop or restart"}
	}
	if _, err := docker(90*time.Second, action, name); err != nil {
		return 502, map[string]any{"error": err.Error()}
	}
	b, _ := docker(10*time.Second, "inspect", "-f", "{{.State.Status}}", name)
	return 200, map[string]any{"host": selfHost, "name": name, "action": action, "state": strings.TrimSpace(string(b))}
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
