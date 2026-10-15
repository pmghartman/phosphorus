// Package modeld: llama-server on the one host with [model] host = true,
// every other host asking it through its frontend (container/model.js's port)
package modeld

import (
	"context"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	stateDir      = util.Env("STATE_DIR", "/state")
	selfHost      = os.Getenv("SELF_HOST")
	claimFile     = filepath.Join(stateDir, "model-claim.json")
	machineFile   = filepath.Join(stateDir, "machine.json")
	installedFile = filepath.Join(stateDir, "model-installed.json")
	slotDir       = filepath.Join(stateDir, "llama-slots")
	llamaDir      = util.Env("LLAMA_DIR", "/opt/llama")
	modelDir      = util.Env("MODEL_DIR", "/models")
	serverPort    = util.EnvInt("MODEL_SERVER_PORT", 8791)
	tickMS        = util.EnvInt("MODEL_TICK_MS", 1000)
	notes         = util.NewNotes("model")
	nvsmi         = []string{"nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi"}
	vramRe        = regexp.MustCompile(`(?i)cudaMalloc failed|out of memory|(failed|unable) to allocate CUDA\d* buffer`)
	hfBlob        = regexp.MustCompile(`^(https://huggingface\.co/.+?)/blob/`)
)

const (
	defaultCtx      = 65536
	defaultSlots    = 4
	needFactor      = 1.03
	kvBytesPerToken = 64 * 1024
	gib             = 1 << 30
	retry           = 15 * time.Second
	downloadRetry   = 60 * time.Second
)

func gb(b float64) string { return fmt.Sprintf("%.1fGB", b/gib) }

func isFile(f string) bool {
	st, err := os.Stat(f)
	return err == nil && st.Mode().IsRegular()
}

func sizeOf(f string) int64 {
	st, err := os.Stat(f)
	if err != nil {
		return 0
	}
	return st.Size()
}

type link struct{ url, file string }

func modelLink(raw string) *link {
	u, err := url.Parse(hfBlob.ReplaceAllString(raw, "$1/resolve/"))
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil
	}
	p, err := url.PathUnescape(u.EscapedPath())
	if err != nil {
		return nil
	}
	f := path.Base(p)
	if !strings.HasSuffix(f, ".gguf") {
		return nil
	}
	return &link{u.String(), f}
}

type config struct {
	raw, url, file string
	ctx, slots     int
	host, gpu      bool
}

func jsNum(s string) float64 {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return f
}

func readConfig() config {
	c := config{raw: util.Ini("model", "url")}
	if l := modelLink(c.raw); l != nil {
		c.url, c.file = l.url, l.file
	}
	c.ctx = int(jsNum(util.Ini("model", "ctx")))
	if c.ctx == 0 {
		c.ctx = defaultCtx
	}
	c.slots = int(math.Floor(jsNum(util.Ini("model", "slots"))))
	if c.slots == 0 {
		c.slots = defaultSlots
	}
	if c.slots < 1 {
		c.slots = 1
	}
	c.host = util.Ini("model", "host") == "true"
	c.gpu = util.Ini("model", "gpu") == "true"
	return c
}

func selfAddr() string {
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				if ip := ipn.IP.To4(); ip != nil && ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127 {
					return ip.String()
				}
			}
		}
	}
	return ""
}

func memTotal() float64 {
	b, _ := os.ReadFile("/proc/meminfo")
	m := regexp.MustCompile(`(?m)^MemTotal:\s+(\d+)`).FindStringSubmatch(string(b))
	if m == nil {
		return 0
	}
	return jsNum(m[1]) * 1024
}

func freeVram() float64 {
	if _, err := os.Stat(filepath.Join(llamaDir, "libggml-cuda.so")); err != nil {
		return 0
	}
	for _, bin := range nvsmi {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, bin, "--query-gpu=memory.free", "--format=csv,noheader,nounits").Output()
		cancel()
		if err != nil {
			continue
		}
		return math.Floor(jsNum(strings.Split(string(out), "\n")[0]) * (1 << 20) * 0.95)
	}
	return 0
}

// --- download ---------------------------------------------------------------

type download struct {
	proc    *exec.Cmd
	file    string
	total   int64
	retryAt time.Time
}

var (
	mu  sync.Mutex
	dl  download
	srv = server{state: "down"}
)

func modelPath(c config) string { return filepath.Join(modelDir, c.file) }

func remoteSize(u string) int64 {
	c := &http.Client{Timeout: 10 * time.Second}
	res, err := c.Head(u)
	if err != nil {
		return 0
	}
	res.Body.Close()
	if n, err := strconv.ParseInt(res.Header.Get("X-Linked-Size"), 10, 64); err == nil && n > 0 {
		return n
	}
	n, _ := strconv.ParseInt(res.Header.Get("Content-Length"), 10, 64)
	return n
}

func pauseDownload(why string) {
	p, f := dl.proc, dl.file
	dl.proc = nil
	if p != nil && p.Process != nil {
		p.Process.Kill()
	}
	notes.Log(fmt.Sprintf("download of %s paused (%s)", f, why))
}

func ensureModel(c config) bool {
	if dl.proc != nil && dl.file != c.file {
		pauseDownload(c.file + " named instead")
	}
	if isFile(modelPath(c)) {
		return true
	}
	if dl.proc != nil || time.Now().Before(dl.retryAt) {
		return false
	}
	part := modelPath(c) + ".part"
	cmd := exec.Command("curl", "-fsSL", "--retry", "5", "--retry-delay", "5", "-C", "-", "-o", part, c.url)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		dl.retryAt = time.Now().Add(downloadRetry)
		notes.Log(fmt.Sprintf("download of %s failed (%v), retrying in %ds", c.file, err, int(downloadRetry.Seconds())))
		return false
	}
	dl = download{proc: cmd, file: c.file}
	u, _ := url.Parse(c.url)
	notes.Log(fmt.Sprintf("downloading %s from %s", c.file, u.Host))
	go func() {
		n := remoteSize(c.url)
		mu.Lock()
		if dl.proc == cmd {
			dl.total = n
		}
		mu.Unlock()
	}()
	go func() {
		err := cmd.Wait()
		mu.Lock()
		defer mu.Unlock()
		if dl.proc != cmd {
			return
		}
		dl.proc = nil
		if err == nil {
			if os.Rename(part, filepath.Join(modelDir, dl.file)) == nil {
				notes.Log(dl.file + " downloaded")
				return
			}
		}
		code := "0"
		if ee, ok := err.(*exec.ExitError); ok {
			code = strconv.Itoa(ee.ExitCode())
			if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				code = ws.Signal().String()
			}
		} else if err != nil {
			code = err.Error()
		}
		dl.retryAt = time.Now().Add(downloadRetry)
		notes.Log(fmt.Sprintf("download of %s failed (%s), retrying in %ds", dl.file, code, int(downloadRetry.Seconds())))
	}()
	return false
}

type installedT struct {
	URL  string `json:"url"`
	File string `json:"file"`
}

var installed *installedT

func replaceOld(c config) {
	if installed != nil && installed.URL == c.url {
		return
	}
	if installed != nil && installed.File != "" {
		if dl.proc != nil {
			pauseDownload(c.file + " named instead")
		}
		stopServer()
		for _, f := range []string{installed.File, installed.File + ".part"} {
			if os.Remove(filepath.Join(modelDir, f)) == nil {
				notes.Log(fmt.Sprintf("uninstalled %s, replaced by %s", f, c.file))
			}
		}
	}
	installed = &installedT{c.url, c.file}
	util.WriteJSONAtomic(installedFile, installed)
}

// --- llama-server -----------------------------------------------------------

type server struct {
	proc    *exec.Cmd
	sig     string
	state   string
	retryAt time.Time
	since   int64
}

type troubleT struct {
	exits    int
	lastExit string
	oom      bool
}

var (
	vram     float64
	fitNeed  float64
	fitWhy   string
	trouble  troubleT
	triedSig string
)

func stopServer() {
	if srv.proc != nil && srv.proc.Process != nil {
		srv.proc.Process.Signal(syscall.SIGTERM)
	}
	srv = server{state: "down"}
}

func healthy() bool {
	c := &http.Client{Timeout: 1500 * time.Millisecond, Transport: &http.Transport{Proxy: nil}}
	res, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/health", serverPort))
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == 200
}

func serve(c config) {
	if srv.proc == nil && (!c.gpu || !time.Now().Before(srv.retryAt)) {
		if c.gpu {
			mu.Unlock()
			v := freeVram()
			mu.Lock()
			vram = v
		} else {
			vram = 0
		}
	}
	if c.gpu && vram == 0 {
		fitNeed = 0
		if _, err := os.Stat(filepath.Join(llamaDir, "libggml-cuda.so")); err == nil {
			fitWhy = "gpu is on but no nvidia gpu is usable here"
		} else {
			fitWhy = "gpu is on but llama-server here has no cuda, phosphorus update rebuilds it"
		}
		notes.Note("gpu", fitWhy)
		stopServer()
		srv.retryAt = time.Now().Add(retry)
		return
	}
	notes.Clear("gpu")
	need := math.Ceil(float64(sizeOf(modelPath(c)))*needFactor + float64(c.ctx)*kvBytesPerToken)
	has := memTotal() + vram
	fitNeed, fitWhy = need, ""
	if has < need {
		h := selfHost
		if h == "" {
			h = "the model host"
		}
		fitWhy = fmt.Sprintf("%s has %s, short of the %s %s needs at %d ctx", h, gb(has), gb(need), c.file, c.ctx)
		notes.Note("fit", fitWhy)
		stopServer()
		return
	}
	notes.Clear("fit")
	sig := string(util.Marshal([]any{c.file, c.ctx, c.slots, c.gpu}))
	if srv.proc != nil && srv.sig == sig {
		p := srv.proc
		mu.Unlock()
		up := healthy()
		mu.Lock()
		if srv.proc != p {
			return
		}
		if up && srv.state != "ready" {
			notes.Log(c.file + " loaded")
			trouble = troubleT{}
		}
		if up {
			srv.state = "ready"
		} else {
			srv.state = "loading"
		}
		return
	}
	if srv.proc != nil {
		notes.Log("[model] changed, reloading")
		stopServer()
		return
	}
	if time.Now().Before(srv.retryAt) {
		return
	}
	os.MkdirAll(slotDir, 0o755)
	if sig != triedSig {
		trouble = troubleT{}
		triedSig = sig
	}
	load := "mlock"
	if c.gpu {
		load = "dio"
	}
	args := []string{"-m", modelPath(c), "--load-mode", load,
		"-c", strconv.Itoa(c.ctx), "-np", strconv.Itoa(c.slots), "--kv-unified", "--jinja",
		"-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"}
	if c.gpu {
		args = append(args, "--device", "CUDA0", "-ngl", "999")
	} else {
		args = append(args, "-ngl", "0")
	}
	cache := "2048"
	if c.gpu {
		cache = "0"
	}
	args = append(args, "--cache-ram", cache, "--cache-reuse", "256", "--slots", "--slot-save-path", slotDir,
		"--host", "127.0.0.1", "--port", strconv.Itoa(serverPort))
	cmd := exec.Command(filepath.Join(llamaDir, "llama-server"), args...)
	cmd.Env = append(os.Environ(), "LD_LIBRARY_PATH="+llamaDir)
	cmd.Stdout = os.Stdout
	stderr, _ := cmd.StderrPipe()
	oom := false
	var oomMu sync.Mutex
	gone := func(why string) {
		mu.Lock()
		defer mu.Unlock()
		if srv.proc != cmd {
			return
		}
		srv = server{state: "down", retryAt: time.Now().Add(retry)}
		oomMu.Lock()
		o := oom
		oomMu.Unlock()
		trouble = troubleT{trouble.exits + 1, why, o}
		notes.Log(fmt.Sprintf("llama-server stopped (%s), retrying in %ds", why, int(retry.Seconds())))
	}
	if err := cmd.Start(); err != nil {
		srv = server{proc: cmd, sig: sig, state: "loading", since: util.Now()}
		mu.Unlock()
		gone(err.Error())
		mu.Lock()
		return
	}
	v := vram
	go func() {
		buf := make([]byte, 8192)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				os.Stderr.Write(buf[:n])
				if v > 0 && vramRe.Match(buf[:n]) {
					oomMu.Lock()
					oom = true
					oomMu.Unlock()
				}
			}
			if err != nil {
				return
			}
		}
	}()
	srv = server{proc: cmd, sig: sig, state: "loading", since: util.Now()}
	on := ""
	if vram > 0 {
		on = fmt.Sprintf("the gpu's %s and ", gb(vram))
	}
	notes.Log(fmt.Sprintf("loading %s on %s%s ram, %s needed", c.file, on, gb(memTotal()), gb(need)))
	go func() {
		err := cmd.Wait()
		why := "exit 0"
		if ee, ok := err.(*exec.ExitError); ok {
			why = fmt.Sprintf("exit %d", ee.ExitCode())
			if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				why = "SIG" + strings.ToUpper(strings.TrimPrefix(unixSigName(ws.Signal()), "SIG"))
			}
		} else if err != nil {
			why = err.Error()
		}
		gone(why)
	}()
}

func unixSigName(s syscall.Signal) string {
	switch s {
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGSEGV:
		return "SIGSEGV"
	case syscall.SIGABRT:
		return "SIGABRT"
	}
	return s.String()
}

// --- the tick ---------------------------------------------------------------

func claim(c config) map[string]any {
	var machine map[string]any
	util.ReadJSON(machineFile, &machine)
	ram, _ := machine["ram"].(float64)
	out := map[string]any{"host": selfHost, "ip": selfAddr(), "runs": c.host, "total": memTotal(), "machine": ram}
	if c.host {
		var d any
		if dl.proc != nil {
			d = map[string]any{"done": sizeOf(modelPath(c) + ".part"), "total": dl.total}
		}
		for k, v := range map[string]any{
			"file": c.file, "size": sizeOf(modelPath(c)), "ctx": c.ctx, "slots": c.slots, "gpu": vram > 0, "vram": vram,
			"server": srv.state, "serverSince": srv.since, "need": fitNeed, "why": fitWhy,
			"exits": trouble.exits, "lastExit": trouble.lastExit, "oom": trouble.oom, "download": d,
		} {
			out[k] = v
		}
	}
	return out
}

func tick() {
	c := readConfig()
	mu.Lock()
	defer mu.Unlock()
	if !c.host || c.file == "" {
		if dl.proc != nil {
			if c.host {
				pauseDownload("[model] url cleared")
			} else {
				pauseDownload("[model] host is off")
			}
		}
		stopServer()
		fitNeed = 0
		switch {
		case !c.host:
			fitWhy = ""
		case c.raw != "":
			fitWhy = "[model] url isn't a https link to a single .gguf: " + c.raw
		default:
			fitWhy = "no model yet, enter its download link in the model tab of phosphorus"
		}
		if fitWhy != "" {
			notes.Note("link", fitWhy)
		} else {
			notes.Clear("link")
		}
	} else {
		replaceOld(c)
		if ensureModel(c) {
			serve(c)
		} else {
			stopServer()
		}
	}
	if c.file != "" {
		notes.Clear("link")
	}
	util.WriteJSONAtomic(claimFile, claim(c))
}

// Main the daemon until SIGTERM
func Main() int {
	os.MkdirAll(modelDir, 0o755)
	var inst installedT
	if util.ReadJSON(installedFile, &inst) {
		installed = &inst
	}
	h := selfHost
	if h == "" {
		h = "an unnamed host"
	}
	notes.Log("starting as " + h)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	for {
		t0 := time.Now()
		func() {
			defer func() {
				if r := recover(); r != nil {
					notes.Note("tick", fmt.Sprintf("tick failed, still retrying: %v", r))
				}
			}()
			tick()
			notes.Clear("tick")
		}()
		wait := time.Duration(tickMS)*time.Millisecond - time.Since(t0)
		if wait < 0 {
			wait = 0
		}
		select {
		case <-sig:
			os.Remove(claimFile)
			mu.Lock()
			for _, p := range []*exec.Cmd{srv.proc, dl.proc} {
				if p != nil && p.Process != nil {
					p.Process.Signal(syscall.SIGTERM)
				}
			}
			mu.Unlock()
			return 0
		case <-time.After(wait):
		}
	}
}

var _ = io.Discard
