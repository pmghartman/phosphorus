package stats

import (
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

var (
	realFS    = regexp.MustCompile(`^(ext[234]|xfs|btrfs|zfs|f2fs|bcachefs|jfs|reiserfs|ntfs3?|fuseblk|exfat|vfat|hfsplus|apfs|9p|drvfs|virtiofs)$`)
	virtualIf = regexp.MustCompile(`^(lo|veth|docker|br-|virbr|cni|flannel|kube)`)
	wholeDisk = regexp.MustCompile(`^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$`)
	octalRe   = regexp.MustCompile(`\\([0-7]{3})`)
)

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
		if strings.HasPrefix(dir, "/") && realFS.MatchString(v[sep+1]) {
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

// --- containers ----------------------------------------------------------------

// roleOf the PHOSPHORUS_ROLE phosphorus run gave a process, its children inheriting it
func roleOf(pid string) string {
	for _, kv := range strings.Split(read("/proc/"+pid+"/environ"), "\x00") {
		if strings.HasPrefix(kv, "PHOSPHORUS_ROLE=") {
			return kv[len("PHOSPHORUS_ROLE="):]
		}
	}
	return ""
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

func vendorGpus(haveNvidia bool) []map[string]any {
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

// --- processes -----------------------------------------------------------------

var (
	procPrev = map[string]float64{}
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
	cur := map[string]float64{}
	list := []map[string]any{}
	roles := map[string]map[string]any{}
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
		row := map[string]any{"pid": n, "name": st[strings.Index(st, "(")+1 : cl], "cpu": cpu, "mem": rss}
		{
			if role := roleOf(pid); role != "" {
				row["role"] = role
				r := roles[role]
				if r == nil {
					r = map[string]any{"name": role, "cpu": 0.0, "mem": 0.0, "pids": 0.0}
					roles[role] = r
				}
				r["cpu"] = math.Round(10*(r["cpu"].(float64)+cpu)) / 10
				r["mem"] = r["mem"].(float64) + rss
				r["pids"] = r["pids"].(float64) + 1
			}
		}
		list = append(list, row)
	}
	procPrev = cur
	{
		rl := []map[string]any{}
		for _, r := range roles {
			rl = append(rl, r)
		}
		sort.SliceStable(rl, func(i, j int) bool { return rl[i]["name"].(string) < rl[j]["name"].(string) })
		dmu.Lock()
		containers = rl
		dmu.Unlock()
	}
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
	procList = map[string]any{"count": len(list), "top": top}
}

func bootIDOf() string { return strings.TrimSpace(read("/proc/sys/kernel/random/boot_id")) }

func loadAvg() []any {
	la := strings.Fields(read("/proc/loadavg"))
	ld := []any{}
	for i := 0; i < 3; i++ {
		if i < len(la) {
			ld = append(ld, num(la[i]))
		} else {
			ld = append(ld, nil)
		}
	}
	return ld
}

func uptimeSecs() float64 {
	up := strings.Fields(read("/proc/uptime"))
	if len(up) == 0 {
		return 0
	}
	return num(up[0])
}

func resetProcs() {
	procPrev = map[string]float64{}
	procAt = 0
	procList = nil
}
