package host

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pmghartman/phosphorus/internal/envfile"
)

// child one process phosphorus run keeps, labelled by PHOSPHORUS_ROLE
type child struct {
	role  string
	core  bool
	grace time.Duration
	argv  []string
	env   []string
	// third-party output, prefixed with the role
	prefix bool

	mu      sync.Mutex
	cmd     *exec.Cmd
	done    chan struct{}
	started time.Time
}

func (c *child) start() error {
	cmd := exec.Command(c.argv[0], c.argv[1:]...)
	cmd.Env = append(append([]string{}, c.env...), "PHOSPHORUS_ROLE="+c.role)
	cmd.Dir = home
	// its own group, killed whole on the way out; gone with run if run dies
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}
	var out io.Writer = os.Stdout
	if c.prefix {
		out = prefixed(c.role)
	}
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	c.mu.Lock()
	c.cmd, c.done, c.started = cmd, done, time.Now()
	c.mu.Unlock()
	go func() { cmd.Wait(); close(done) }()
	return nil
}

// stop TERM to the child alone, its own shutdown in order, then its group killed
func (c *child) stop() {
	c.mu.Lock()
	cmd, done := c.cmd, c.done
	c.mu.Unlock()
	if cmd == nil {
		return
	}
	select {
	case <-done:
		return
	default:
	}
	cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(c.grace):
		say("%s ignored TERM for %s, killing it", c.role, c.grace)
	}
	syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	<-done
}

func prefixed(role string) io.Writer {
	r, w := io.Pipe()
	go func() {
		s := bufio.NewScanner(r)
		s.Buffer(make([]byte, 64*1024), 1024*1024)
		for s.Scan() {
			fmt.Printf("[%s] %s\n", role, s.Text())
		}
	}()
	return w
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// tailnetSelf this node's DNS name, logging in with TS_AUTHKEY when it isn't
func tailnetSelf() (string, error) {
	type status struct {
		BackendState string
		Self         struct{ DNSName string }
	}
	read := func() (status, error) {
		var st status
		out, err := exec.Command("tailscale", "status", "--json").Output()
		if err == nil {
			err = json.Unmarshal(out, &st)
		}
		return st, err
	}
	var st status
	var err error
	for i := 0; i < 60; i++ {
		if st, err = read(); err == nil && st.BackendState != "" && st.BackendState != "NoState" && st.BackendState != "Starting" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if st.BackendState != "Running" {
		key := os.Getenv("TS_AUTHKEY")
		if key == "" {
			return "", fail("tailscale is %s and there's no TS_AUTHKEY in .env to log in with", strings.ToLower(st.BackendState))
		}
		a := []string{"up", "--authkey=" + key, "--accept-dns=true"}
		if h := os.Getenv("TS_HOSTNAME"); h != "" {
			a = append(a, "--hostname="+h)
		}
		say("logging tailscale in...")
		if err := run("tailscale", a...); err != nil {
			return "", fail("couldn't join the tailnet, check TS_AUTHKEY in .env (it must be reusable and unexpired)")
		}
		if st, err = read(); err != nil {
			return "", err
		}
	}
	return strings.TrimSuffix(st.Self.DNSName, "."), nil
}

// fillMeshKeys a joining host's missing keys from a peer, waited on only
// when this host can't run without them
func fillMeshKeys() {
	need := os.Getenv("BASE_DOMAIN") == "" || os.Getenv("TUNNEL_TOKEN") == ""
	missing := false
	for _, k := range envfile.Keys {
		missing = missing || (k.Mesh && os.Getenv(k.Name) == "")
	}
	if !missing {
		return
	}
	tries := 1
	if need {
		tries = 30
	}
	for i := 0; i < tries; i++ {
		if vals, err := meshKeyValues(); err == nil {
			for k, v := range vals {
				os.Setenv(k, v)
			}
			return
		}
		time.Sleep(2 * time.Second)
	}
}

func waitHealthz() {
	c := &http.Client{Timeout: time.Second}
	for i := 0; i < 100; i++ {
		if r, err := c.Get("http://127.0.0.1:80/healthz"); err == nil {
			r.Body.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// runHost systemd's main process: tailscale checked, the frontend, the tunnel,
// the model and git daemons as labelled children, all down with a core one
func runHost() error {
	tag = "run"
	os.MkdirAll(runDir, 0o755)
	env := runEnv()
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		os.Setenv(k, v)
	}
	if !fileExists(nativeEnvFile()) {
		return fail("no %s, run: phos start", nativeEnvFile())
	}
	dns, err := tailnetSelf()
	if err != nil {
		return err
	}
	say("on the tailnet as %s", dns)
	fillMeshKeys()
	if os.Getenv("BASE_DOMAIN") == "" || os.Getenv("TUNNEL_TOKEN") == "" {
		return fail("no BASE_DOMAIN or TUNNEL_TOKEN and no peer to copy them from: the first host of a mesh needs them in .env")
	}
	os.WriteFile(at("state", "base-domain"), []byte(os.Getenv("BASE_DOMAIN")+"\n"), 0o644)
	first, _, _ := strings.Cut(dns, ".")
	os.Setenv("SELF_HOST", strings.Trim(slugRe.ReplaceAllString(strings.ToLower(first), "-"), "-"))
	os.Setenv("HOST_SSH_PORT", "22")
	env = withPath(os.Environ())
	bin := binPath("phosphorus")

	frontend := &child{role: "frontend", core: true, grace: 15 * time.Second, argv: []string{bin, "serve"}, env: env}
	tunnel := &child{role: "cloudflared", core: true, grace: 10 * time.Second, prefix: true, env: env,
		argv: []string{filepath.Join(libexec, "cloudflared"), "tunnel", "--no-autoupdate", "--loglevel", "warn", "run"}}
	kids := []*child{frontend}
	extra := []*child{}
	if isModelHost() {
		extra = append(extra, &child{role: "model", grace: 30 * time.Second, argv: []string{bin, "model"}, env: env})
	}
	if isGitHost() {
		extra = append(extra, &child{role: "git", grace: 60 * time.Second, env: env,
			argv: []string{"/bin/bash", at("container", "git", "git-daemon.sh")}})
	}

	if err := frontend.start(); err != nil {
		return fail("couldn't start the frontend: %v", err)
	}
	// the ingress answering before the tunnel hands it anything
	waitHealthz()
	say("tunnel: joining the Cloudflare tunnel as a replica")
	if err := tunnel.start(); err != nil {
		frontend.stop()
		return fail("couldn't start cloudflared: %v", err)
	}
	kids = append(kids, tunnel)
	for _, c := range extra {
		if err := c.start(); err != nil {
			say("couldn't start %s: %v", c.role, err)
		}
	}
	all := append(append([]*child{}, kids...), extra...)
	names := []string{}
	for _, c := range all {
		names = append(names, c.role)
	}
	say("all up: %s", strings.Join(names, " "))

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	exited := make(chan *child, len(all))
	var watch func(c *child)
	watch = func(c *child) {
		c.mu.Lock()
		done := c.done
		c.mu.Unlock()
		if done == nil {
			return
		}
		<-done
		exited <- c
	}
	for _, c := range all {
		go watch(c)
	}
	// git before the model, both before the tunnel and frontend, so a
	// master hands off while the mesh can still see it
	shutdown := func() {
		for i := len(all) - 1; i >= 0; i-- {
			all[i].stop()
		}
	}
	backoff := map[string]time.Duration{}
	for {
		select {
		case s := <-sig:
			say("%s, shutting down", s)
			shutdown()
			return nil
		case c := <-exited:
			if c.core {
				say("%s exited, stopping the rest so this host leaves tunnel rotation", c.role)
				shutdown()
				return exitCode(1)
			}
			d := backoff[c.role]
			// a long run forgiven, a crash loop slowed
			if d == 0 || time.Since(c.started) > 5*time.Minute {
				d = 5 * time.Second
			}
			say("%s exited, restarting it in %s", c.role, d)
			backoff[c.role] = min(d*2, time.Minute)
			go func(c *child, d time.Duration) {
				time.Sleep(d)
				if err := c.start(); err != nil {
					say("couldn't restart %s: %v", c.role, err)
				}
				watch(c)
			}(c, d)
		}
	}
}
