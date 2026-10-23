package main

// Sulfur's window: the system's web view around the page this server serves, the
// page's own title bar the window's. The page reaches the window through
// window.sulfurApp, defined only for Sulfur's own origin; each OS file gives the
// window itself and what a title bar needs of it

import (
	"encoding/json"
	"errors"
	"net/url"
	"os/exec"
	"runtime"
	"sync/atomic"
)

// what both web view libraries give, and the bridge needs
type webHost interface {
	Bind(name string, f any) error
	Init(js string)
	Eval(js string)
	SetTitle(title string)
	Dispatch(f func())
}

// pick what the page asks of a dialog
type pick struct {
	Directory   bool   `json:"directory"`
	Title       string `json:"title"`
	DefaultPath string `json:"defaultPath"`
}

// shell what an OS gives the title bar; decorated when the system draws one itself
type shell struct {
	minimize, toggleMaximize, destroy func()
	maximized                         func() bool
	drag                              func(x, y int)
	pick                              func(pick) string
	decorated                         bool
	show                              func() // the window shown once the page is up; nil where it's shown at once
}

// closeReady whether the page has said it can ask about unsaved files; until then a close just closes
var closeReady atomic.Bool

// bridge the page's window.sulfurApp, over the host's bound functions
func bridge(h webHost, origin string, s shell) error {
	on := func(name string, f any) error { return h.Bind(name, f) }
	// the window's own calls run on its thread
	ui := func(f func()) { h.Dispatch(f) }
	for name, f := range map[string]any{
		"sx_minimize": func() { ui(s.minimize) },
		"sx_maximize": func() { ui(s.toggleMaximize) },
		"sx_maxed":    func() bool { return s.maximized() },
		"sx_drag":     func(x, y int) { ui(func() { s.drag(x, y) }) },
		"sx_title":    func(t string) { ui(func() { h.SetTitle(t) }) },
		"sx_destroy":  func() { ui(s.destroy) },
		"sx_ready": func() {
			trace("page ready")
			closeReady.Store(true)
			if s.show != nil {
				ui(s.show)
			}
		},
		"sx_open": func(u string) error { return openURL(u) },
		"sx_pick": func(p pick) string { return s.pick(p) },
	} {
		if err := on(name, f); err != nil {
			return err
		}
	}
	o, _ := json.Marshal(origin)
	h.Init(`(function(){
  if (location.origin !== ` + string(o) + `) return;
  var c = function (n) { return function () { return window[n].apply(null, arguments); }; };
  window.sulfurApp = {
    os: ` + `"` + runtime.GOOS + `"` + `,
    decorated: ` + map[bool]string{true: "true", false: "false"}[s.decorated] + `,
    minimize: c('sx_minimize'), toggleMaximize: c('sx_maximize'), isMaximized: c('sx_maxed'),
    startDragging: function (e) { return window.sx_drag(e ? e.screenX | 0 : 0, e ? e.screenY | 0 : 0); },
    setTitle: c('sx_title'), destroy: c('sx_destroy'), ready: c('sx_ready'), openUrl: c('sx_open'),
    pick: function (o) { return window.sx_pick(o || {}); }
  };
})();`)
	return nil
}

// closing a close the user asked for with the window's own control: the page asked
// about unsaved files first, else closed at once
func closing(h webHost, s shell) {
	if !closeReady.Load() {
		s.destroy()
		return
	}
	h.Eval(`window.dispatchEvent(new Event('sulfur-close'))`)
}

// originOf a page address as its origin, scheme and host
func originOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// openURL a web address in the system's browser; only http and https
func openURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("not a web address")
	}
	var c *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		c = exec.Command("rundll32", "url.dll,FileProtocolHandler", u.String())
	case "darwin":
		c = exec.Command("open", u.String())
	default:
		c = exec.Command("xdg-open", u.String())
	}
	detach(c)
	return c.Start()
}
