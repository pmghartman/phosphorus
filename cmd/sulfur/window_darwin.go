//go:build darwin && cgo

package main

// macOS: WKWebView through cgo (window_darwin.m), the title bar the page's own under
// the system's traffic lights

/*
#cgo CFLAGS: -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include <stdlib.h>
#include "window_darwin.h"
*/
import "C"

import (
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
	cstr("Sulfur", func(t *C.char) { C.sx_new(t, 1320, 860, 640, 420) })
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
		drag:           func(int, int) { C.sx_drag() },
		pick:           pickPath,
	}
	if err := bridge(h, originOf(url), theShell); err != nil {
		return err
	}
	cstr(url, func(p *C.char) { C.sx_navigate(p) })
	C.sx_run()
	return nil
}
