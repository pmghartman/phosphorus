// Package stats: this host's cpu, memory, disk, network, gpus, containers and
// processes, sampled only while watched, peers fanned in, one socket each
package stats

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

const (
	sampleMS    = 1000
	dockerMS    = 5000
	gpuMS       = 2000
	procMS      = 2000
	procTop     = 25
	clkTck      = 100
	page        = 4096
	peerRetry   = 3 * time.Second
	netBucketMS = 5 * 60 * 1000
	dayMS       = 24 * 3600 * 1000
)

var (
	mountRoots = []string{"/state", "/files", "/repo"}
	shares     = "/shares"
	hostRoot   = func() string {
		if os.Getenv("PHOSPHORUS_HOST_ROOT") != "" {
			return "/hostfs"
		}
		return ""
	}()
	realFS    = regexp.MustCompile(`^(ext[234]|xfs|btrfs|zfs|f2fs|bcachefs|jfs|reiserfs|ntfs3?|fuseblk|exfat|vfat|hfsplus|apfs|9p|drvfs|virtiofs)$`)
	virtualIf = regexp.MustCompile(`^(lo|veth|docker|br-|virbr|cni|flannel|kube)`)
	tunnelIf  = regexp.MustCompile(`^(tailscale|wg|tun|utun)`)
	wholeDisk = regexp.MustCompile(`^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$`)
	octalRe   = regexp.MustCompile(`\\([0-7]{3})`)
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

func cpuTimes() []cpuT {
	out := []cpuT{}
	for _, line := range strings.Split(read("/proc/stat"), "\n") {
		if !strings.HasPrefix(line, "cpu") {
			break
		}
		f := strings.Fields(line)[1:]
		v := make([]float64, len(f))
		for i, x := range f {
			v[i] = num(x)
		}
		at := func(i int) float64 {
			if i < len(v) && !math.IsNaN(v[i]) {
				return v[i]
			}
			return 0
		}
		total := 0.0
		for i := 0; i < 8 && i < len(v); i++ {
			total += v[i]
		}
		out = append(out, cpuT{at(3) + at(4), total})
	}
	return out
}

func memInfo() map[string]any {
	kb := map[string]float64{}
	re := regexp.MustCompile(`^(\w+):\s+(\d+)`)
	for _, line := range strings.Split(read("/proc/meminfo"), "\n") {
		if m := re.FindStringSubmatch(line); m != nil {
			kb[m[1]] = num(m[2]) * 1024
		}
	}
	total := kb["MemTotal"]
	avail, ok := kb["MemAvailable"]
	if !ok {
		avail = kb["MemFree"]
	}
	return map[string]any{
		"total": total, "used": total - avail, "avail": avail,
		"cached":    kb["Cached"] + kb["Buffers"],
		"swapTotal": kb["SwapTotal"], "swapUsed": kb["SwapTotal"] - kb["SwapFree"],
	}
}

type rxtx struct {
	RX float64 `json:"rx"`
	TX float64 `json:"tx"`
}

func netBytes() (map[string]rxtx, []string) {
	out := map[string]rxtx{}
	order := []string{}
	lines := strings.Split(read("/proc/net/dev"), "\n")
	if len(lines) > 2 {
		lines = lines[2:]
	} else {
		lines = nil
	}
	for _, line := range lines {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) < 2 {
			continue
		}
		name := strings.TrimSpace(parts[0])
		if virtualIf.MatchString(name) {
			continue
		}
		f := strings.Fields(parts[1])
		if len(f) < 9 {
			continue
		}
		out[name] = rxtx{num(f[0]), num(f[8])}
		order = append(order, name)
	}
	return out, order
}

func diskBytes() (float64, float64) {
	var r, w float64
	for _, line := range strings.Split(read("/proc/diskstats"), "\n") {
		v := strings.Fields(line)
		if len(v) < 10 || !wholeDisk.MatchString(v[2]) {
			continue
		}
		r += num(v[5]) * 512
		w += num(v[9]) * 512
	}
	return r, w
}

type mount struct{ dir, dev string }

func diskMounts() []mount {
	out := []mount{}
	for _, line := range strings.Split(read("/proc/self/mountinfo"), "\n") {
		v := strings.Split(line, " ")
		sep := -1
		for i, x := range v {
			if x == "-" {
				sep = i
				break
			}
		}
		if sep < 0 || len(v) <= sep+1 || len(v) < 5 {
			continue
		}
		dir := octalRe.ReplaceAllStringFunc(v[4], func(m string) string {
			n, _ := strconv.ParseInt(m[1:], 8, 32)
			return string(rune(n))
		})
		bound := false
		for _, r := range mountRoots {
			bound = bound || dir == r
		}
		bound = bound || strings.HasPrefix(dir, shares+"/")
		host := hostRoot != "" && (dir == hostRoot || strings.HasPrefix(dir, hostRoot+"/")) && realFS.MatchString(v[sep+1])
		if bound || host {
			out = append(out, mount{dir, v[2]})
		}
	}
	return out
}

func disk() map[string]any {
	seen := map[string]bool{}
	var total, used float64
	count := 0
	for _, m := range diskMounts() {
		if seen[m.dev] {
			continue
		}
		var s syscall.Statfs_t
		if syscall.Statfs(m.dir, &s) != nil {
			continue
		}
		key := fmt.Sprintf("%d:%d:%d:%d", s.Blocks, s.Bfree, s.Bsize, s.Type)
		if s.Blocks == 0 || seen[key] {
			continue
		}
		seen[m.dev] = true
		seen[key] = true
		total += float64(s.Blocks) * float64(s.Bsize)
		used += float64(s.Blocks-s.Bfree) * float64(s.Bsize)
		count++
	}
	return map[string]any{"total": total, "used": used, "count": count}
}

var (
	cpuModelOnce sync.Once
	cpuModelV    string
)

func cpuModel() string {
	cpuModelOnce.Do(func() {
		if m := regexp.MustCompile(`(?m)^model name\s*:\s*(.+)$`).FindStringSubmatch(read("/proc/cpuinfo")); m != nil {
			cpuModelV = m[1]
		}
	})
	return cpuModelV
}

// --- net totals over the last day --------------------------------------------

type netDayT struct {
	Boot    string          `json:"boot"`
	Last    map[string]rxtx `json:"last"`
	Buckets [][3]float64    `json:"buckets"`
	At      *float64        `json:"at,omitempty"`
}

var (
	netDayFile = filepath.Join(util.Env("STATE_DIR", "/state"), "net-day.json")
	bootID     = strings.TrimSpace(read("/proc/sys/kernel/random/boot_id"))
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

// --- containers ----------------------------------------------------------------

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

var (
	dmu        sync.Mutex
	containers any = []any{}
	dockerBusy bool
	dockerAt   int64
)

func refreshDocker() {
	dmu.Lock()
	if dockerBusy || util.Now()-dockerAt < dockerMS {
		dmu.Unlock()
		return
	}
	dockerBusy = true
	dmu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		out, err := exec.CommandContext(ctx, "docker", "stats", "--no-stream", "--format", "{{json .}}").Output()
		cancel()
		dmu.Lock()
		defer dmu.Unlock()
		dockerBusy = false
		dockerAt = util.Now()
		if err != nil {
			containers = nil
			return
		}
		list := []map[string]any{}
		for _, l := range strings.Split(string(out), "\n") {
			var c map[string]any
			if l == "" || json.Unmarshal([]byte(l), &c) != nil {
				continue
			}
			cpu, _ := strconv.ParseFloat(strings.TrimSuffix(util.JSString(c["CPUPerc"]), "%"), 64)
			pids, _ := strconv.ParseFloat(util.JSString(c["PIDs"]), 64)
			list = append(list, map[string]any{"name": c["Name"], "cpu": cpu, "mem": toBytes(strings.Split(util.JSString(c["MemUsage"]), "/")[0]), "pids": pids})
		}
		sort.SliceStable(list, func(i, j int) bool {
			a, b := list[i], list[j]
			if a["cpu"].(float64) != b["cpu"].(float64) {
				return a["cpu"].(float64) > b["cpu"].(float64)
			}
			return a["mem"].(float64) > b["mem"].(float64)
		})
		containers = list
	}()
}

// --- gpus ------------------------------------------------------------------------

var (
	nvsmi   = []string{"nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi"}
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

func numFile(f string) any {
	v := strings.TrimSpace(read(f))
	if v == "" {
		return nil
	}
	n := num(v)
	if math.IsNaN(n) {
		return nil
	}
	return n
}

func integrated(v, dev string) bool {
	if v == "intel" {
		m := regexp.MustCompile(`PCI_SLOT_NAME=(\S+)`).FindStringSubmatch(read(dev + "/uevent"))
		return m != nil && regexp.MustCompile(`:00:02\.0$`).MatchString(m[1])
	}
	if v == "amd" {
		x := strings.TrimSpace(read(dev + "/mem_info_vram_vendor"))
		return x == "" || x == "unknown"
	}
	return false
}

func sysfsGpus(haveNvidia bool) []map[string]any {
	out := []map[string]any{}
	for _, c := range readdir("/sys/class/drm") {
		if !regexp.MustCompile(`^card\d+$`).MatchString(c) {
			continue
		}
		dev := "/sys/class/drm/" + c + "/device"
		v := vendor[strings.TrimSpace(read(dev+"/vendor"))]
		if v == "" || (v == "nvidia" && haveNvidia) || integrated(v, dev) {
			continue
		}
		var temp any
		if hw := readdir(dev + "/hwmon"); len(hw) > 0 {
			if t, ok := numFile(dev + "/hwmon/" + hw[0] + "/temp1_input").(float64); ok {
				temp = math.Round(t / 1000)
			}
		}
		name := strings.TrimSpace(read(dev + "/product_name"))
		if name == "" {
			name = v + " gpu"
		}
		out = append(out, map[string]any{
			"name": strings.ToLower(name), "util": numFile(dev + "/gpu_busy_percent"),
			"memUsed": numFile(dev + "/mem_info_vram_used"), "memTotal": numFile(dev + "/mem_info_vram_total"),
			"mhz": numFile("/sys/class/drm/" + c + "/gt_act_freq_mhz"), "mhzMax": numFile("/sys/class/drm/" + c + "/gt_max_freq_mhz"),
			"temp": temp,
		})
	}
	return out
}

func gpus() []map[string]any {
	refreshNvidia()
	gmu.Lock()
	nv := append([]map[string]any{}, nvidia...)
	gmu.Unlock()
	return append(nv, sysfsGpus(len(nv) > 0)...)
}

// --- processes -----------------------------------------------------------------

var (
	procPrev = map[string]float64{}
	procAt   int64
	procs    any
)

func refreshProcs(now int64) {
	if now-procAt < procMS {
		return
	}
	secs := 0.0
	if procAt != 0 {
		secs = float64(now-procAt) / 1000
	}
	procAt = now
	cur := map[string]float64{}
	list := []map[string]any{}
	for _, pid := range readdir("/proc") {
		if _, err := strconv.Atoi(pid); err != nil {
			continue
		}
		st := read("/proc/" + pid + "/stat")
		cl := strings.LastIndex(st, ")")
		if cl < 0 || cl+2 > len(st) {
			continue
		}
		f := strings.Split(st[cl+2:], " ")
		if len(f) < 22 {
			continue
		}
		rss := num(f[21]) * page
		if rss == 0 || math.IsNaN(rss) {
			continue
		}
		ticks := num(f[11]) + num(f[12])
		cur[pid] = ticks
		cpu := 0.0
		if was, ok := procPrev[pid]; ok && secs > 0 {
			cpu = math.Round(1000*(ticks-was)/clkTck/secs) / 10
		}
		n, _ := strconv.Atoi(pid)
		list = append(list, map[string]any{"pid": n, "name": st[strings.Index(st, "(")+1 : cl], "cpu": cpu, "mem": rss})
	}
	procPrev = cur
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a["cpu"].(float64) != b["cpu"].(float64) {
			return a["cpu"].(float64) > b["cpu"].(float64)
		}
		return a["mem"].(float64) > b["mem"].(float64)
	})
	top := list
	if len(top) > procTop {
		top = top[:procTop]
	}
	for _, p := range top {
		cmd := []string{}
		for _, x := range strings.Split(read(fmt.Sprintf("/proc/%d/cmdline", p["pid"])), "\x00") {
			if x != "" {
				cmd = append(cmd, x)
			}
		}
		if len(cmd) > 0 {
			c := strings.Join(cmd, " ")
			if r := []rune(c); len(r) > 300 {
				c = string(r[:300])
			}
			p["cmd"] = c
			if b := filepath.Base(cmd[0]); b != "" {
				p["name"] = b
			}
		}
	}
	procs = map[string]any{"count": len(list), "top": top}
}

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
	la := strings.Fields(read("/proc/loadavg"))
	ld := []any{}
	for i := 0; i < 3; i++ {
		if i < len(la) {
			ld = append(ld, num(la[i]))
		} else {
			ld = append(ld, nil)
		}
	}
	refreshDocker()
	refreshProcs(now)
	nets := []map[string]any{}
	for _, n := range order {
		v := cur.net[n]
		p, ok := last.net[n]
		nets = append(nets, map[string]any{"name": n, "rx": rate(v.RX, p.RX, ok), "tx": rate(v.TX, p.TX, ok)})
	}
	up := strings.Fields(read("/proc/uptime"))
	uptime := 0.0
	if len(up) > 0 {
		uptime = math.Round(num(up[0]))
	}
	dmu.Lock()
	ctr := containers
	dmu.Unlock()
	out := Hooks.Self()
	for k, v := range map[string]any{
		"at":  now,
		"cpu": map[string]any{"total": cpus[0], "cores": cpus[1:], "model": cpuModel(), "load": ld},
		"mem": memInfo(), "net": nets, "netDay": netDayTotals(),
		"io":   map[string]any{"r": rate(cur.r, last.r, true), "w": rate(cur.w, last.w, true)},
		"disk": disk(), "gpus": gpus(), "uptime": uptime, "containers": ctr, "procs": procs,
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
		procPrev = map[string]float64{}
		procAt = 0
		procs = nil
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
