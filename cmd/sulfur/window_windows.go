package main

// Windows: WebView2 through a pure Go binding, no cgo. The window is frameless, its
// title bar the page's own; the system's sizing frame stays, so the edges still resize

import (
	_ "embed"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

//go:embed assets/icon.ico
var windowIcon []byte

// the web view's thread is the one that made it
func init() { runtime.LockOSThread() }

// showError what stopped the window, in a message box: a windowed app has no console
func showError(msg string) {
	t, _ := windows.UTF16PtrFromString("Sulfur")
	m, _ := windows.UTF16PtrFromString(msg)
	windows.MessageBox(0, m, t, windows.MB_OK|windows.MB_ICONERROR)
}

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	comdlg32 = windows.NewLazySystemDLL("comdlg32.dll")
	ole32    = windows.NewLazySystemDLL("ole32.dll")

	pShowWindow          = user32.NewProc("ShowWindow")
	pIsZoomed            = user32.NewProc("IsZoomed")
	pSendMessage         = user32.NewProc("SendMessageW")
	pReleaseCapture      = user32.NewProc("ReleaseCapture")
	pSetWindowLongPtr    = user32.NewProc("SetWindowLongPtrW")
	pCallWindowProc      = user32.NewProc("CallWindowProcW")
	pMonitorFromWindow   = user32.NewProc("MonitorFromWindow")
	pGetMonitorInfo      = user32.NewProc("GetMonitorInfoW")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pSetWindowPos        = user32.NewProc("SetWindowPos")
	pCreateIconFromRes   = user32.NewProc("CreateIconFromResourceEx")
	pSetClassLongPtr     = user32.NewProc("SetClassLongPtrW")
	pCreateSolidBrush    = windows.NewLazySystemDLL("gdi32.dll").NewProc("CreateSolidBrush")
	pBrowseForFolder     = shell32.NewProc("SHBrowseForFolderW")
	pPathFromIDList      = shell32.NewProc("SHGetPathFromIDListW")
	pGetOpenFileName     = comdlg32.NewProc("GetOpenFileNameW")
	pCoTaskMemFree       = ole32.NewProc("CoTaskMemFree")

	forceClose atomic.Bool
	oldProc    uintptr
	appHwnd    uintptr
)

const (
	wmNCCalcSize    = 0x0083
	wmClose         = 0x0010
	wmSetIcon       = 0x0080
	wmNCLButtonDown = 0x00A1
	htCaption       = 2
	swMinimize      = 6
	swMaximize      = 3
	swRestore       = 9
	// frame changed, no move, size, z order or activation
	swpFrame = 0x0020 | 0x0002 | 0x0001 | 0x0004 | 0x0010
)

type rect struct{ left, top, right, bottom int32 }

type monitorInfo struct {
	size    uint32
	monitor rect
	work    rect
	flags   uint32
}

// wndProc the window's procedure ahead of the library's: the frame's title taken
// out of the client area, a close from the window's own controls handed to the page
func wndProc(sh *shell, h *webHost) uintptr {
	return windows.NewCallback(func(hwnd, msg, wp, lp uintptr) uintptr {
		switch msg {
		case wmNCCalcSize:
			if wp == 0 {
				break
			}
			p := (*rect)(*(*unsafe.Pointer)(unsafe.Pointer(&lp)))
			if z, _, _ := pIsZoomed.Call(hwnd); z != 0 {
				// maximized: the monitor's work area, not the frame hanging over its edges
				mon, _, _ := pMonitorFromWindow.Call(hwnd, 2)
				mi := monitorInfo{size: uint32(unsafe.Sizeof(monitorInfo{}))}
				if r, _, _ := pGetMonitorInfo.Call(mon, uintptr(unsafe.Pointer(&mi))); r != 0 {
					*p = mi.work
				}
				return 0
			}
			// the system's sizing frame on three sides; the title gone from the top, a pixel left to grab
			top := p.top
			r, _, _ := pCallWindowProc.Call(oldProc, hwnd, msg, wp, lp)
			p.top = top + 1
			return r
		case wmClose:
			if !forceClose.Load() {
				closing(*h, *sh)
				return 0
			}
		}
		r, _, _ := pCallWindowProc.Call(oldProc, hwnd, msg, wp, lp)
		return r
	})
}

// the window's own dark, under the page: the web view's background, the class's brush
const darkBg = 0x1f1f1f

func runWindow(url string) error {
	if os.Getenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR") == "" {
		os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF1F1F1F")
	}
	// the web view's data folder, named by the app's identifier: the page's layout and open tabs live in it
	local := os.Getenv("LOCALAPPDATA")
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		DataPath:  filepath.Join(local, "dev.phosphorus.sulfur", "EBWebView"),
		WindowOptions: webview2.WindowOptions{
			Title: "Sulfur", Width: 1320, Height: 860, Center: true,
		},
	})
	if w == nil {
		return errors.New("WebView2 didn't start; its runtime is from https://developer.microsoft.com/microsoft-edge/webview2/")
	}
	defer w.Destroy()
	appHwnd = uintptr(w.Window())
	// hidden until the page has drawn, so the web view's white start never shows; the brush
	// meanwhile dark for a window that does
	pShowWindow.Call(appHwnd, 0)
	brush, _, _ := pCreateSolidBrush.Call(darkBg)
	pSetClassLongPtr.Call(appHwnd, ^uintptr(9), brush) // GCLP_HBRBACKGROUND, -10
	setIcons(appHwnd)

	var host webHost = w
	sh := shell{
		minimize:       func() { pShowWindow.Call(appHwnd, swMinimize) },
		toggleMaximize: toggleMax,
		maximized:      func() bool { z, _, _ := pIsZoomed.Call(appHwnd); return z != 0 },
		destroy:        func() { forceClose.Store(true); w.Destroy() },
		drag: func(int, int) {
			pReleaseCapture.Call()
			pSendMessage.Call(appHwnd, wmNCLButtonDown, htCaption, 0)
		},
		pick: pickWindows,
		show: showWindow,
	}
	oldProc, _, _ = pSetWindowLongPtr.Call(appHwnd, ^uintptr(3), wndProc(&sh, &host)) // GWLP_WNDPROC, -4
	// the frame recalculated now: the title bar out of the client area
	pSetWindowPos.Call(appHwnd, 0, 0, 0, 0, 0, swpFrame)
	w.SetSize(640, 420, webview2.HintMin)
	if err := bridge(host, originOf(url), sh); err != nil {
		return err
	}
	w.Navigate(url)
	// a page that never says it's ready (the server's error page) shown anyway
	time.AfterFunc(8*time.Second, func() { w.Dispatch(showWindow) })
	w.Run()
	return nil
}

func showWindow() {
	pShowWindow.Call(appHwnd, 5)
	pSetForegroundWindow.Call(appHwnd)
}

func toggleMax() {
	if z, _, _ := pIsZoomed.Call(appHwnd); z != 0 {
		pShowWindow.Call(appHwnd, swRestore)
	} else {
		pShowWindow.Call(appHwnd, swMaximize)
	}
}

// setIcons the window's big and small icon, from the .ico's own images
func setIcons(hwnd uintptr) {
	if len(windowIcon) < 6 {
		return
	}
	n := int(binary.LittleEndian.Uint16(windowIcon[4:]))
	images := map[int][]byte{}
	for i := 0; i < n && 6+16*(i+1) <= len(windowIcon); i++ {
		e := windowIcon[6+16*i:]
		w := int(e[0])
		if w == 0 {
			w = 256
		}
		size, off := int(binary.LittleEndian.Uint32(e[8:])), int(binary.LittleEndian.Uint32(e[12:]))
		if off+size <= len(windowIcon) {
			images[w] = windowIcon[off : off+size]
		}
	}
	for _, c := range []struct {
		want int
		kind uintptr // ICON_SMALL 0, ICON_BIG 1
	}{{32, 1}, {16, 0}} {
		for _, w := range []int{c.want, 48, 64, 128, 256} {
			data, ok := images[w]
			if !ok {
				continue
			}
			ic, _, _ := pCreateIconFromRes.Call(uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), 1, 0x00030000, uintptr(c.want), uintptr(c.want), 0)
			if ic != 0 {
				pSendMessage.Call(hwnd, wmSetIcon, c.kind, ic)
			}
			break
		}
	}
}

// pickWindows the system's folder or file dialog over the window
func pickWindows(p pick) string {
	title, _ := windows.UTF16PtrFromString(p.Title)
	if p.Directory {
		buf := make([]uint16, 520)
		bi := struct {
			owner       uintptr
			root        uintptr
			displayName *uint16
			title       *uint16
			flags       uint32
			fn          uintptr
			param       uintptr
			image       int32
		}{owner: appHwnd, displayName: &buf[0], title: title, flags: 0x1 | 0x40} // file system folders only, the new style
		pidl, _, _ := pBrowseForFolder.Call(uintptr(unsafe.Pointer(&bi)))
		if pidl == 0 {
			return ""
		}
		defer pCoTaskMemFree.Call(pidl)
		if r, _, _ := pPathFromIDList.Call(pidl, uintptr(unsafe.Pointer(&buf[0]))); r == 0 {
			return ""
		}
		return windows.UTF16ToString(buf)
	}
	file := make([]uint16, 1040)
	var ofn struct {
		size                       uint32
		owner, inst                uintptr
		filter, customFilter       *uint16
		maxCustFilter, filterIndex uint32
		file                       *uint16
		maxFile                    uint32
		fileTitle                  *uint16
		maxFileTitle               uint32
		initialDir, title          *uint16
		flags                      uint32
		fileOffset, fileExtension  uint16
		defExt                     *uint16
		custData, hook             uintptr
		template                   *uint16
		pvReserved                 uintptr
		dwReserved, flagsEx        uint32
	}
	ofn.size = uint32(unsafe.Sizeof(ofn))
	ofn.owner = appHwnd
	ofn.file, ofn.maxFile = &file[0], uint32(len(file))
	ofn.title = title
	if p.DefaultPath != "" {
		ofn.initialDir, _ = windows.UTF16PtrFromString(p.DefaultPath)
	}
	ofn.flags = 0x00080000 | 0x00001000 | 0x00000800 | 0x00000008 // explorer, file and path must exist, the folder kept
	if r, _, _ := pGetOpenFileName.Call(uintptr(unsafe.Pointer(&ofn))); r == 0 {
		return ""
	}
	return windows.UTF16ToString(file)
}
