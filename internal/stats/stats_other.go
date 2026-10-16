//go:build !linux

package stats

import (
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/shirou/gopsutil/v4/cpu"
	gdisk "github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"

	"github.com/pmghartman/phosphorus/internal/procs"
)

// macOS and Windows through gopsutil, the same shapes as Linux's /proc

var virtualIf = regexp.MustCompile(`(?i)^(lo|loopback|vEthernet|veth|bridge|awdl|llw|anpi|ap\d|gif|stf|isatap|teredo)`)

func cpuTimes() []cpuT {
	conv := func(t cpu.TimesStat) cpuT {
		idle := t.Idle + t.Iowait
		return cpuT{idle, idle + t.User + t.System + t.Nice + t.Irq + t.Softirq + t.Steal}
	}
	all, err := cpu.Times(false)
	if err != nil || len(all) == 0 {
		return nil
	}
	out := []cpuT{conv(all[0])}
	if per, err := cpu.Times(true); err == nil {
		for _, t := range per {
			out = append(out, conv(t))
		}
	}
	return out
}

func memInfo() map[string]any {
	v, err := mem.VirtualMemory()
	if err != nil {
		return map[string]any{}
	}
	out := map[string]any{"total": float64(v.Total), "used": float64(v.Total - v.Available), "avail": float64(v.Available),
		"cached": float64(v.Cached + v.Buffers), "swapTotal": 0.0, "swapUsed": 0.0}
	if s, err := mem.SwapMemory(); err == nil {
		out["swapTotal"], out["swapUsed"] = float64(s.Total), float64(s.Used)
	}
	return out
}

func netBytes() (map[string]rxtx, []string) {
	out := map[string]rxtx{}
	order := []string{}
	all, _ := net.IOCounters(true)
	for _, c := range all {
		if virtualIf.MatchString(c.Name) || c.BytesRecv+c.BytesSent == 0 {
			continue
		}
		out[c.Name] = rxtx{float64(c.BytesRecv), float64(c.BytesSent)}
		order = append(order, c.Name)
	}
	return out, order
}

func diskBytes() (float64, float64) {
	var r, w float64
	all, _ := gdisk.IOCounters()
	for _, c := range all {
		r += float64(c.ReadBytes)
		w += float64(c.WriteBytes)
	}
	return r, w
}

// disk every real volume once, macOS's APFS container counted a single time
func disk() map[string]any {
	parts, _ := gdisk.Partitions(false)
	seen := map[string]bool{}
	var total, used float64
	count := 0
	for _, p := range parts {
		u, err := gdisk.Usage(p.Mountpoint)
		if err != nil || u.Total == 0 {
			continue
		}
		key := strconv.FormatUint(u.Total, 10) + ":" + strconv.FormatUint(u.Free, 10)
		if strings.HasPrefix(p.Mountpoint, "/System/Volumes/") && p.Mountpoint != "/System/Volumes/Data" || seen[key] {
			continue
		}
		seen[key] = true
		total += float64(u.Total)
		used += float64(u.Used)
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
		if i, err := cpu.Info(); err == nil && len(i) > 0 {
			cpuModelV = strings.TrimSpace(i[0].ModelName)
		}
	})
	return cpuModelV
}

func bootIDOf() string {
	if b, err := host.BootTime(); err == nil {
		return strconv.FormatUint(b, 10)
	}
	return ""
}

// loadAvg none on Windows
func loadAvg() []any {
	if l, err := load.Avg(); err == nil && l.Load1+l.Load5+l.Load15 > 0 {
		return []any{l.Load1, l.Load5, l.Load15}
	}
	return []any{nil, nil, nil}
}

func uptimeSecs() float64 {
	u, _ := host.Uptime()
	return float64(u)
}

func sysfsGpus(bool) []map[string]any { return nil }

var (
	procPrev = map[int32]float64{}
	procAt   int64
	procList any
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
	cur := map[int32]float64{}
	list := []map[string]any{}
	roles := map[string]map[string]any{}
	for _, p := range procs.List() {
		if p.RSS == 0 {
			continue
		}
		cur[p.PID] = p.CPU
		cpuPct := 0.0
		if was, ok := procPrev[p.PID]; ok && secs > 0 {
			cpuPct = math.Round(1000*(p.CPU-was)/secs) / 10
		}
		name := p.Name
		if name == "" {
			name = filepath.Base(p.Cmd)
		}
		row := map[string]any{"pid": int(p.PID), "name": strings.TrimSuffix(name, ".exe"), "cpu": cpuPct, "mem": float64(p.RSS)}
		if c := []rune(p.Cmd); len(c) > 300 {
			row["cmd"] = string(c[:300])
		} else if p.Cmd != "" {
			row["cmd"] = p.Cmd
		}
		if p.Role != "" {
			row["role"] = p.Role
			r := roles[p.Role]
			if r == nil {
				r = map[string]any{"name": p.Role, "cpu": 0.0, "mem": 0.0, "pids": 0.0}
				roles[p.Role] = r
			}
			r["cpu"] = math.Round(10*(r["cpu"].(float64)+cpuPct)) / 10
			r["mem"] = r["mem"].(float64) + float64(p.RSS)
			r["pids"] = r["pids"].(float64) + 1
		}
		list = append(list, row)
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
	procList = map[string]any{"count": len(list), "top": top}
	rl := []map[string]any{}
	for _, r := range roles {
		rl = append(rl, r)
	}
	sort.SliceStable(rl, func(i, j int) bool { return rl[i]["name"].(string) < rl[j]["name"].(string) })
	dmu.Lock()
	containers = rl
	dmu.Unlock()
}

func resetProcs() {
	procPrev = map[int32]float64{}
	procAt = 0
	procList = nil
}
