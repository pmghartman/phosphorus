package main

// The page's calls into Go for the windows built here (Linux's GTK, macOS's
// Cocoa): the web view posts a JSON line, Go runs the bound function and answers
// through the page's own promise. Windows' library does the same itself

import (
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"sync"
)

type rpcHost struct {
	initJS, evalJS, setTitle func(string)
	post                     func(id uintptr) // asks the window's thread to call run(id)

	mu    sync.Mutex
	fns   map[string]reflect.Value
	queue map[uintptr]func()
	next  uintptr
}

func newRPC() *rpcHost {
	h := &rpcHost{fns: map[string]reflect.Value{}, queue: map[uintptr]func(){}}
	return h
}

func (h *rpcHost) Init(js string)    { h.initJS(js) }
func (h *rpcHost) Eval(js string)    { h.evalJS(js) }
func (h *rpcHost) SetTitle(t string) { h.setTitle(t) }
func (h *rpcHost) Dispatch(f func()) {
	h.mu.Lock()
	h.next++
	id := h.next
	h.queue[id] = f
	h.mu.Unlock()
	h.post(id)
}

// run a queued function, on the window's thread
func (h *rpcHost) run(id uintptr) {
	h.mu.Lock()
	f := h.queue[id]
	delete(h.queue, id)
	h.mu.Unlock()
	if f != nil {
		f()
	}
}

// Bind a Go function as window[name], returning a promise to the page
func (h *rpcHost) Bind(name string, f any) error {
	v := reflect.ValueOf(f)
	if v.Kind() != reflect.Func || v.Type().NumOut() > 2 {
		return errors.New("only functions of at most two results can be bound")
	}
	h.mu.Lock()
	h.fns[name] = v
	h.mu.Unlock()
	n, _ := json.Marshal(name)
	h.initJS(`(function(){
  var name = ` + string(n) + `;
  if (!window.__sx) window.__sx = { seq: 0, calls: {} };
  window[name] = function () {
    var args = Array.prototype.slice.call(arguments), id = ++window.__sx.seq;
    return new Promise(function (resolve, reject) {
      window.__sx.calls[id] = { resolve: resolve, reject: reject };
      window.webkit.messageHandlers.sx.postMessage(JSON.stringify({ id: id, name: name, params: args }));
    });
  };
  window.__sxReply = function (id, ok, value) {
    var c = window.__sx.calls[id];
    if (!c) return;
    delete window.__sx.calls[id];
    if (ok) c.resolve(value); else c.reject(value);
  };
})();`)
	return nil
}

// handle one posted call: run on its own goroutine, so a dialog doesn't hold the window
func (h *rpcHost) handle(line string) {
	var m struct {
		ID     int               `json:"id"`
		Name   string            `json:"name"`
		Params []json.RawMessage `json:"params"`
	}
	if json.Unmarshal([]byte(line), &m) != nil {
		return
	}
	h.mu.Lock()
	fn, ok := h.fns[m.Name]
	h.mu.Unlock()
	if !ok {
		return
	}
	go func() {
		out, err := call(fn, m.Params)
		reply := "__sxReply(" + strconv.Itoa(m.ID) + ","
		if err != nil {
			e, _ := json.Marshal(err.Error())
			reply += "false," + string(e) + ")"
		} else {
			b, _ := json.Marshal(out)
			if out == nil {
				b = []byte("null")
			}
			reply += "true," + string(b) + ")"
		}
		h.Dispatch(func() { h.evalJS(reply) })
	}()
}

func call(fn reflect.Value, params []json.RawMessage) (any, error) {
	t := fn.Type()
	if len(params) != t.NumIn() {
		return nil, errors.New("wrong number of arguments")
	}
	in := make([]reflect.Value, t.NumIn())
	for i := range in {
		p := reflect.New(t.In(i))
		if err := json.Unmarshal(params[i], p.Interface()); err != nil {
			return nil, err
		}
		in[i] = p.Elem()
	}
	out := fn.Call(in)
	switch len(out) {
	case 0:
		return nil, nil
	case 1:
		if e, ok := out[0].Interface().(error); ok {
			return nil, e
		}
		return out[0].Interface(), nil
	}
	if e, _ := out[1].Interface().(error); e != nil {
		return nil, e
	}
	return out[0].Interface(), nil
}
