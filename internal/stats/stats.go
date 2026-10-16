// Package stats: this host's cpu, memory, disk, network, gpus, phosphorus's
// own processes by role and the top ones, sampled only while watched, peers fanned in, one socket each
package stats

import (
	"bufio"
	"context"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

const (
	sampleMS    = 1000
	gpuMS       = 2000
	procMS      = 2000
	procTop     = 25
	clkTck      = 100
	page        = 4096
	peerRetry   = 3 * time.Second
	netBucketMS = 5 * 60 * 1000
	dayMS       = 24 * 3600 * 1000
)

func read(f string) string {
	b, err := os.ReadFile(f)
	if err != nil {
		return ""
	}
	return string(b)
}

func readdir(d string) []string {
	ents, err := os.ReadDir(d)
	if err != nil {
		return nil
	}
	out := make([]string, len(ents))
	for i, e := range ents {
		out[i] = e.Name()
	}
	return out
}

func num(s string) float64 {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

type cpuT struct{ idle, total float64 }

type rxtx struct {
	RX float64 `json:"rx"`
	TX float64 `json:"tx"`
}

var tunnelIf = regexp.MustCompile(`(?i)^(tailscale|wg|tun|utun)`)

// --- net totals over the last day --------------------------------------------

type netDayT struct {
	Boot    string          `json:"boot"`
	Last    map[string]rxtx `json:"last"`
	Buckets [][3]float64    `json:"buckets"`
	At      *float64        `json:"at,omitempty"`
}

var (
	netDayFile = filepath.Join(util.Env("STATE_DIR", "/state"), "net-day.json")
	bootID     = bootIDOf()
	ndMu       sync.Mutex
	netDay     netDayT
)

func realLinks() map[string]rxtx {
	all, _ := netBytes()
	out := map[string]rxtx{}
	for n, v := range all {
		if !tunnelIf.MatchString(n) {
			out[n] = v
		}
	}
	return out
}

func netSince(cur map[string]rxtx) rxtx {
	var d rxtx
	fresh := netDay.Boot != bootID
	for n, v := range cur {
		p, ok := netDay.Last[n]
		if fresh {
			ok = false
		}
		if ok && v.RX >= p.RX {
			d.RX += v.RX - p.RX
		} else {
			d.RX += v.RX
		}
		if ok && v.TX >= p.TX {
			d.TX += v.TX - p.TX
		} else {
			d.TX += v.TX
		}
	}
	return d
}

func netDayTick() {
	ndMu.Lock()
	defer ndMu.Unlock()
	now := float64(util.Now())
	cur := realLinks()
	if netDay.Last != nil {
		d := netSince(cur)
		netDay.Buckets = append(netDay.Buckets, [3]float64{now, d.RX, d.TX})
	}
	kept := [][3]float64{}
	for _, b := range netDay.Buckets {
		if now-b[0] < dayMS {
			kept = append(kept, b)
		}
	}
	netDay.Buckets = kept
	netDay.Last = cur
	netDay.Boot = bootID
	util.WriteJSONAtomic(netDayFile, netDay)
}

func netDayTotals() map[string]any {
	ndMu.Lock()
	defer ndMu.Unlock()
	d := netSince(realLinks())
	for _, b := range netDay.Buckets {
		d.RX += b[1]
		d.TX += b[2]
	}
	var since any
	if len(netDay.Buckets) > 0 {
		since = netDay.Buckets[0][0] - netBucketMS
	} else if netDay.At != nil {
		since = *netDay.At
	}
	return map[string]any{"rx": d.RX, "tx": d.TX, "since": since}
}

var unitMul = map[string]float64{"b": 1, "kb": 1e3, "mb": 1e6, "gb": 1e9, "tb": 1e12, "kib": 1024, "mib": 1 << 20, "gib": 1 << 30, "tib": 1 << 40}
var bytesRe = regexp.MustCompile(`(?i)^([\d.]+)\s*([a-z]*)$`)

func toBytes(s string) float64 {
	m := bytesRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0
	}
	u, ok := unitMul[strings.ToLower(m[2])]
	if !ok {
		u = 1
	}
	return num(m[1]) * u
}

// --- gpus ------------------------------------------------------------------------

var (
	nvsmi   = []string{"nvidia-smi"}
	vendor  = map[string]string{"0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel"}
	gmu     sync.Mutex
	nvsmiAt int
	nvidia  = []map[string]any{}
	gpuBusy bool
	gpuAt   int64
)

func refreshNvidia() {
	gmu.Lock()
	if gpuBusy || nvsmiAt >= len(nvsmi) || util.Now()-gpuAt < gpuMS {
		gmu.Unlock()
		return
	}
	gpuBusy = true
	bin := nvsmi[nvsmiAt]
	gmu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, bin, "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits").Output()
		cancel()
		gmu.Lock()
		defer gmu.Unlock()
		gpuBusy = false
		gpuAt = util.Now()
		if err != nil {
			if _, ok := err.(*exec.Error); ok {
				nvsmiAt++
			}
			nvidia = []map[string]any{}
			return
		}
		list := []map[string]any{}
		for _, l := range strings.Split(string(out), "\n") {
			if l == "" {
				continue
			}
			p := strings.Split(l, ",")
			for len(p) < 5 {
				p = append(p, "")
			}
			z := func(s string) float64 {
				v := num(s)
				if math.IsNaN(v) {
					return 0
				}
				return v
			}
			var temp any
			if t := z(p[4]); t != 0 {
				temp = t
			}
			list = append(list, map[string]any{"name": strings.ToLower(strings.TrimSpace(p[0])), "util": z(p[1]),
				"memUsed": z(p[2]) * (1 << 20), "memTotal": z(p[3]) * (1 << 20), "temp": temp})
		}
		nvidia = list
	}()
}

func gpus() []map[string]any {
	refreshNvidia()
	gmu.Lock()
	nv := append([]map[string]any{}, nvidia...)
	gmu.Unlock()
	return append(nv, sysfsGpus(len(nv) > 0)...)
}

// containers phosphorus's own processes by role, from refreshProcs
var (
	dmu        sync.Mutex
	containers any = []any{}
)

// --- own sampler -----------------------------------------------------------

// Hooks self() and peers() from server
var Hooks = struct {
	Self  func() map[string]any
	Peers func() map[string]string
}{func() map[string]any { return map[string]any{} }, func() map[string]string { return nil }}

type sampleState struct {
	at   int64
	cpu  []cpuT
	net  map[string]rxtx
	r, w float64
}

var (
	smu       sync.Mutex
	listeners = map[int]func(string){}
	lid       int
	prev      *sampleState
	latest    string
	ticker    *time.Ticker
	stopTick  chan struct{}
)

func round(x float64) float64 { return math.Floor(x + 0.5) }

func sample() map[string]any {
	now := util.Now()
	cur := &sampleState{at: now, cpu: cpuTimes()}
	var order []string
	cur.net, order = netBytes()
	cur.r, cur.w = diskBytes()
	last := prev
	prev = cur
	if last == nil || len(cur.cpu) == 0 {
		return nil
	}
	secs := float64(now-last.at) / 1000
	pct := func(a cpuT, i int) float64 {
		if i >= len(last.cpu) {
			return 0
		}
		b := last.cpu[i]
		if a.total > b.total {
			return round(1000*(1-(a.idle-b.idle)/(a.total-b.total))) / 10
		}
		return 0
	}
	rate := func(a, b float64, ok bool) float64 {
		if ok && a >= b && secs > 0 {
			return round((a - b) / secs)
		}
		return 0
	}
	cpus := make([]float64, len(cur.cpu))
	for i, c := range cur.cpu {
		cpus[i] = pct(c, i)
	}
	ld := loadAvg()
	refreshProcs(now)
	nets := []map[string]any{}
	for _, n := range order {
		v := cur.net[n]
		p, ok := last.net[n]
		nets = append(nets, map[string]any{"name": n, "rx": rate(v.RX, p.RX, ok), "tx": rate(v.TX, p.TX, ok)})
	}
	uptime := math.Round(uptimeSecs())
	dmu.Lock()
	ctr := containers
	dmu.Unlock()
	out := Hooks.Self()
	for k, v := range map[string]any{
		"at":  now,
		"cpu": map[string]any{"total": cpus[0], "cores": cpus[1:], "model": cpuModel(), "load": ld},
		"mem": memInfo(), "net": nets, "netDay": netDayTotals(),
		"io":   map[string]any{"r": rate(cur.r, last.r, true), "w": rate(cur.w, last.w, true)},
		"disk": disk(), "gpus": gpus(), "uptime": uptime, "containers": ctr, "procs": procList,
	} {
		out[k] = v
	}
	return out
}

func tick() {
	smu.Lock()
	s := sample()
	if s == nil {
		smu.Unlock()
		return
	}
	latest = string(util.Marshal(s))
	fns := []func(string){}
	for _, f := range listeners {
		fns = append(fns, f)
	}
	t := latest
	smu.Unlock()
	for _, f := range fns {
		f(t)
	}
}

func listen(fn func(string)) func() {
	smu.Lock()
	lid++
	id := lid
	listeners[id] = fn
	start := ticker == nil
	if start {
		ticker = time.NewTicker(sampleMS * time.Millisecond)
		stopTick = make(chan struct{})
		t, stop := ticker, stopTick
		go func() {
			for {
				select {
				case <-t.C:
					tick()
				case <-stop:
					return
				}
			}
		}()
	}
	l := latest
	smu.Unlock()
	if start {
		tick()
	} else if l != "" {
		fn(l)
	}
	return func() {
		smu.Lock()
		defer smu.Unlock()
		delete(listeners, id)
		if len(listeners) > 0 || ticker == nil {
			return
		}
		ticker.Stop()
		close(stopTick)
		ticker = nil
		prev = nil
		latest = ""
		resetProcs()
	}
}

// --- peers fanned in ------------------------------------------------------

type peerConn struct {
	ip   string
	stop chan struct{}
}

var (
	pmu        sync.Mutex
	peers      = map[string]*peerConn{}
	peerLatest = map[string]string{}
	browsers   = map[*wsock.Conn]bool{}
	reconStop  chan struct{}
)

func toBrowsers(text string) {
	pmu.Lock()
	bs := []*wsock.Conn{}
	for b := range browsers {
		bs = append(bs, b)
	}
	pmu.Unlock()
	for _, b := range bs {
		b.Text(text)
	}
}

func dialPeer(host, ip string) {
	p := &peerConn{ip: ip, stop: make(chan struct{})}
	peers[host] = p
	go func() {
		for {
			ws, err := wsock.Dial(fmt.Sprintf("ws://%s:%d/api/stats?own", ip, util.FrontendPort), nil, 3*time.Second)
			if err == nil {
				go func() { <-p.stop; ws.Terminate() }()
				for {
					b, _, err := ws.Read()
					if err != nil {
						break
					}
					pmu.Lock()
					if peers[host] == p {
						peerLatest[host] = string(b)
					}
					pmu.Unlock()
					toBrowsers(string(b))
				}
			}
			select {
			case <-p.stop:
				return
			case <-time.After(peerRetry):
			}
		}
	}()
}

func dropPeer(host string) {
	p := peers[host]
	if p == nil {
		return
	}
	delete(peers, host)
	delete(peerLatest, host)
	close(p.stop)
}

func reconcile() {
	want := Hooks.Peers()
	pmu.Lock()
	defer pmu.Unlock()
	for h, p := range peers {
		if want[h] != p.ip {
			dropPeer(h)
		}
	}
	for h, ip := range want {
		if peers[h] == nil {
			dialPeer(h, ip)
		}
	}
}

// Attach a browser: own samples and every peer's, a peer: own only
func Attach(ws *wsock.Conn, own bool) {
	off := listen(func(t string) {
		if ws.Open() {
			ws.Text(t)
		}
	})
	ws.OnClose(off)
	if !own {
		pmu.Lock()
		browsers[ws] = true
		for _, t := range peerLatest {
			ws.Text(t)
		}
		if reconStop == nil {
			reconStop = make(chan struct{})
			stop := reconStop
			go func() {
				reconcile()
				t := time.NewTicker(sampleMS * time.Millisecond)
				defer t.Stop()
				for {
					select {
					case <-t.C:
						reconcile()
					case <-stop:
						return
					}
				}
			}()
		}
		pmu.Unlock()
		ws.OnClose(func() {
			pmu.Lock()
			defer pmu.Unlock()
			delete(browsers, ws)
			if len(browsers) > 0 {
				return
			}
			if reconStop != nil {
				close(reconStop)
				reconStop = nil
			}
			for h := range peers {
				dropPeer(h)
			}
		})
	}
	for {
		if _, _, err := ws.Read(); err != nil {
			return
		}
	}
}

// Init the day's net totals, a baseline written now
func Init() {
	util.ReadJSON(netDayFile, &netDay)
	if netDay.Buckets == nil {
		netDay = netDayT{Buckets: [][3]float64{}}
	}
	netDayTick()
	if netDay.At == nil {
		a := float64(util.Now())
		netDay.At = &a
	}
	go func() {
		for range time.Tick(netBucketMS * time.Millisecond) {
			netDayTick()
		}
	}()
}

var _ = bufio.NewReader
