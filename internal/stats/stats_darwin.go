package stats

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

// memCached the inactive pages, macOS's reclaimable file cache
func memCached(inactive float64) float64 { return inactive }

// Apple silicon's gpu from ioreg's IOAccelerator: its utilization and the
// unified memory it holds, the chip's name for its own

var (
	appleMu   sync.Mutex
	appleGpu  []map[string]any
	appleAt   int64
	appleBusy bool
	ioUtilRe  = regexp.MustCompile(`"Device Utilization %"=(\d+)`)
	ioMemRe   = regexp.MustCompile(`"In use system memory"=(\d+)`)
	ioCoresRe = regexp.MustCompile(`"gpu-core-count" = (\d+)`)
	ioModelRe = regexp.MustCompile(`"model" = "([^"]+)"`)
)

func vendorGpus(bool) []map[string]any {
	appleMu.Lock()
	defer appleMu.Unlock()
	if !appleBusy && util.Now()-appleAt >= gpuMS {
		appleBusy = true
		go func() {
			g := appleSample()
			appleMu.Lock()
			appleGpu, appleAt, appleBusy = g, util.Now(), false
			appleMu.Unlock()
		}()
	}
	return append([]map[string]any{}, appleGpu...)
}

func appleSample() []map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b, err := exec.CommandContext(ctx, "ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator").Output()
	if err != nil {
		return nil
	}
	out := []map[string]any{}
	// one block per accelerator, each opening with +-o
	for _, blk := range strings.Split(string(b), "+-o ")[1:] {
		m := ioUtilRe.FindStringSubmatch(blk)
		if m == nil {
			continue
		}
		u, _ := strconv.ParseFloat(m[1], 64)
		name := "apple gpu"
		if x := ioModelRe.FindStringSubmatch(blk); x != nil {
			name = strings.ToLower(x[1])
		} else if chip := sysctl("machdep.cpu.brand_string"); chip != "" {
			name = strings.ToLower(chip) + " gpu"
		}
		g := map[string]any{"name": name, "util": u, "memUsed": nil, "memTotal": nil, "mhz": nil, "mhzMax": nil, "temp": nil, "integrated": true}
		if x := ioMemRe.FindStringSubmatch(blk); x != nil {
			v, _ := strconv.ParseFloat(x[1], 64)
			g["memUsed"] = v
		}
		if t, err := strconv.ParseFloat(sysctl("hw.memsize"), 64); err == nil {
			g["memTotal"] = t
		}
		if x := ioCoresRe.FindStringSubmatch(blk); x != nil {
			g["cores"], _ = strconv.Atoi(x[1])
		}
		out = append(out, g)
	}
	return out
}

func sysctl(k string) string {
	b, err := exec.Command("sysctl", "-n", k).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
