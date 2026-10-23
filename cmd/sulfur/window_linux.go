//go:build linux && cgo

package main

// Linux: GTK 3 and WebKitGTK 4.1 through cgo (window_linux.c). The system draws the
// title bar, so the page's own buttons stay hidden

/*
#cgo pkg-config: gtk+-3.0 webkit2gtk-4.1
#cgo CFLAGS: -Wno-deprecated-declarations
#include <stdlib.h>
#include "window_linux.h"
*/
import "C"

import (
	"os"
	"path/filepath"
	"runtime"
	"unsafe"
)

func init() { runtime.LockOSThread() }

var theHost *rpcHost
var theShell shell

//export sxMessage
func sxMessage(s *C.char) { theHost.handle(C.GoString(s)) }

//export sxCloseRequest
func sxCloseRequest() { closing(theHost, theShell) }

//export sxIdle
func sxIdle(id C.uintptr_t) { theHost.run(uintptr(id)) }

func cstr(s string, f func(*C.char)) {
	c := C.CString(s)
	defer C.free(unsafe.Pointer(c))
	f(c)
}

func runWindow(url string) error {
	home, _ := os.UserHomeDir()
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		data = filepath.Join(home, ".local", "share")
	}
	cache := os.Getenv("XDG_CACHE_HOME")
	if cache == "" {
		cache = filepath.Join(home, ".cache")
	}
	// the app's identifier names its folders
	d, c := filepath.Join(data, "dev.phosphorus.sulfur"), filepath.Join(cache, "dev.phosphorus.sulfur")
	os.MkdirAll(d, 0o700)
	os.MkdirAll(c, 0o700)
	cstr("Sulfur", func(t *C.char) {
		cstr(d, func(dd *C.char) { cstr(c, func(cc *C.char) { C.sx_new(t, 1320, 860, 640, 420, dd, cc) }) })
	})

	h := newRPC()
	h.initJS = func(js string) { cstr(js, func(p *C.char) { C.sx_init_script(p) }) }
	h.evalJS = func(js string) { cstr(js, func(p *C.char) { C.sx_eval(p) }) }
	h.setTitle = func(t string) { cstr(t, func(p *C.char) { C.sx_title(p) }) }
	h.post = func(id uintptr) { C.sx_post(C.uintptr_t(id)) }
	theHost = h
	theShell = shell{
		minimize:       func() { C.sx_minimize() },
		toggleMaximize: func() { C.sx_toggle_max() },
		maximized:      func() bool { return C.sx_maxed() != 0 },
		destroy:        func() { C.sx_destroy() },
		drag:           func(int, int) {},
		pick:           pickPath,
		decorated:      true,
	}
	if err := bridge(h, originOf(url), theShell); err != nil {
		return err
	}
	cstr(url, func(p *C.char) { C.sx_navigate(p) })
	C.sx_run()
	return nil
}
