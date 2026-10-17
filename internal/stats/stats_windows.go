package stats

import (
	"regexp"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows' gpus, nvidia's left to nvidia-smi: names and vram from dxgi,
// load and vram used from the GPU Engine and GPU Adapter Memory counters

var (
	dxgi    = windows.NewLazySystemDLL("dxgi.dll")
	pdh     = windows.NewLazySystemDLL("pdh.dll")
	newDxgi = dxgi.NewProc("CreateDXGIFactory1")
	pdhOpen = pdh.NewProc("PdhOpenQueryW")
	pdhAdd  = pdh.NewProc("PdhAddEnglishCounterW")
	pdhRead = pdh.NewProc("PdhCollectQueryData")
	pdhList = pdh.NewProc("PdhGetFormattedCounterArrayW")
	// IDXGIFactory1
	factoryIID = windows.GUID{Data1: 0x770aae78, Data2: 0xf26f, Data3: 0x4dba, Data4: [8]byte{0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87}}
	luidRe     = regexp.MustCompile(`luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_phys_(\d+)`)
	engRe      = regexp.MustCompile(`_eng_(\d+)`)
)

type adapter struct {
	name, vendor, luid string
	total              float64
}

// DXGI_ADAPTER_DESC1
type adapterDesc struct {
	desc                                   [128]uint16
	vendorID, deviceID, subSysID, revision uint32
	dedicated, dedicatedSys, sharedSys     uintptr
	luidLow                                uint32
	luidHigh                               int32
	flags                                  uint32
}

// com calls method i of obj's vtable
func com(obj unsafe.Pointer, i int, args ...uintptr) uintptr {
	vt := *(**[16]uintptr)(obj)
	r, _, _ := syscall.SyscallN(vt[i], append([]uintptr{uintptr(obj)}, args...)...)
	return r
}

// adapters the hardware ones, once: software, unknown and integrated gpus left out
var adapters = sync.OnceValue(func() []adapter {
	out := []adapter{}
	if newDxgi.Find() != nil {
		return out
	}
	var f unsafe.Pointer
	if r, _, _ := newDxgi.Call(uintptr(unsafe.Pointer(&factoryIID)), uintptr(unsafe.Pointer(&f))); r != 0 || f == nil {
		return out
	}
	defer com(f, 2)
	for i := 0; ; i++ {
		var a unsafe.Pointer
		// EnumAdapters1, ends on DXGI_ERROR_NOT_FOUND
		if com(f, 12, uintptr(i), uintptr(unsafe.Pointer(&a))) != 0 || a == nil {
			break
		}
		var d adapterDesc
		ok := com(a, 10, uintptr(unsafe.Pointer(&d))) == 0
		com(a, 2)
		v := vendor["0x"+strings.ToLower(hex4(d.vendorID))]
		// software adapter; under 1GB dedicated taken as an igpu's carve-out
		if !ok || d.flags&2 != 0 || v == "" || float64(d.dedicated) < 1<<30 {
			continue
		}
		out = append(out, adapter{
			name: strings.ToLower(windows.UTF16ToString(d.desc[:])), vendor: v, total: float64(d.dedicated),
			luid: strings.ToLower(hex8(uint32(d.luidHigh)) + "_" + hex8(d.luidLow)),
		})
	}
	return out
})

func hex4(v uint32) string { return hexN(v, 4) }
func hex8(v uint32) string { return hexN(v, 8) }

func hexN(v uint32, n int) string {
	const digits = "0123456789abcdef"
	b := make([]byte, n)
	for i := n - 1; i >= 0; i-- {
		b[i] = digits[v&0xf]
		v >>= 4
	}
	return string(b)
}

const pdhMoreData = 0x800007d2

var (
	pq     struct{ query, engine, memory uintptr }
	pqOnce sync.Once
	pqMu   sync.Mutex
)

func openCounters() {
	if pdh.Load() != nil {
		return
	}
	var q uintptr
	if r, _, _ := pdhOpen.Call(0, 0, uintptr(unsafe.Pointer(&q))); r != 0 {
		return
	}
	add := func(path string) uintptr {
		var c uintptr
		p, _ := windows.UTF16PtrFromString(path)
		if r, _, _ := pdhAdd.Call(q, uintptr(unsafe.Pointer(p)), 0, uintptr(unsafe.Pointer(&c))); r != 0 {
			return 0
		}
		return c
	}
	pq.query, pq.engine, pq.memory = q, add(`\GPU Engine(*)\Utilization Percentage`), add(`\GPU Adapter Memory(*)\Dedicated Usage`)
	pdhRead.Call(q)
}

// values each instance of counter c by its name
func values(c uintptr) map[string]float64 {
	out := map[string]float64{}
	if c == 0 {
		return out
	}
	// PDH_FMT_DOUBLE | PDH_FMT_NOCAP100
	const format = 0x200 | 0x8000
	var size, n uint32
	if r, _, _ := pdhList.Call(c, format, uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&n)), 0); r != pdhMoreData || size == 0 {
		return out
	}
	buf := make([]byte, size)
	if r, _, _ := pdhList.Call(c, format, uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(&buf[0]))); r != 0 {
		return out
	}
	// PDH_FMT_COUNTERVALUE_ITEM_W: name, status, value
	type item struct {
		name   *uint16
		status uint32
		_      uint32
		value  float64
	}
	for _, it := range unsafe.Slice((*item)(unsafe.Pointer(&buf[0])), n) {
		if it.status == 0 || it.status == 1 {
			out[windows.UTF16PtrToString(it.name)] += it.value
		}
	}
	return out
}

func vendorGpus(haveNvidia bool) []map[string]any {
	as := adapters()
	if len(as) == 0 {
		return nil
	}
	pqOnce.Do(openCounters)
	pqMu.Lock()
	defer pqMu.Unlock()
	var eng, used map[string]float64
	if pq.query != 0 {
		pdhRead.Call(pq.query)
		eng, used = values(pq.engine), values(pq.memory)
	}
	// an adapter's load its busiest engine's, summed over processes
	busy, mem := map[string]map[string]float64{}, map[string]float64{}
	for inst, v := range eng {
		m, e := luidRe.FindStringSubmatch(inst), engRe.FindStringSubmatch(inst)
		if m == nil || e == nil {
			continue
		}
		l := strings.ToLower(m[1] + "_" + m[2])
		if busy[l] == nil {
			busy[l] = map[string]float64{}
		}
		busy[l][e[1]] += v
	}
	for inst, v := range used {
		if m := luidRe.FindStringSubmatch(inst); m != nil {
			mem[strings.ToLower(m[1]+"_"+m[2])] += v
		}
	}
	out := []map[string]any{}
	for _, a := range as {
		if a.vendor == "nvidia" && haveNvidia {
			continue
		}
		var util, memUsed any
		if b, ok := busy[a.luid]; ok {
			hi := 0.0
			for _, v := range b {
				hi = max(hi, v)
			}
			util = min(hi, 100)
		}
		if u, ok := mem[a.luid]; ok {
			memUsed = u
		}
		out = append(out, map[string]any{"name": a.name, "util": util, "memUsed": memUsed, "memTotal": a.total,
			"mhz": nil, "mhzMax": nil, "temp": nil})
	}
	return out
}
