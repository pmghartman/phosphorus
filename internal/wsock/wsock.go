// Package wsock: one websocket with a write queue, a heartbeat and Node ws's
// close codes, over coder/websocket
package wsock

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	readLimit = 32 << 20
	queueLen  = 1024
	// Heartbeat as server.js's: a socket not answering pings dropped
	Heartbeat = 3 * time.Second
)

type frame struct {
	typ  websocket.MessageType
	data []byte
}

// Conn one socket
type Conn struct {
	c       *websocket.Conn
	out     chan frame
	done    chan struct{}
	closing atomic.Bool
	once    sync.Once
	ctx     context.Context
	cancel  context.CancelFunc
	onClose []func()
	mu      sync.Mutex
	code    atomic.Int32
}

func wrap(c *websocket.Conn) *Conn {
	c.SetReadLimit(readLimit)
	ctx, cancel := context.WithCancel(context.Background())
	k := &Conn{c: c, out: make(chan frame, queueLen), done: make(chan struct{}), ctx: ctx, cancel: cancel}
	go k.writer()
	return k
}

// Accept an upgrade, origin checks left to the caller as Node's ws
func Accept(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return nil, err
	}
	return wrap(c), nil
}

// Dial a peer's socket, handshake capped at timeout
func Dial(url string, header http.Header, timeout time.Duration) (*Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: header, CompressionMode: websocket.CompressionDisabled,
		HTTPClient: &http.Client{Transport: &http.Transport{Proxy: nil}},
	})
	if err != nil {
		return nil, err
	}
	return wrap(c), nil
}

func (k *Conn) writer() {
	for {
		select {
		case f := <-k.out:
			ctx, cancel := context.WithTimeout(k.ctx, 30*time.Second)
			err := k.c.Write(ctx, f.typ, f.data)
			cancel()
			if err != nil {
				k.Terminate()
				return
			}
		case <-k.done:
			return
		}
	}
}

// Open while it can still send
func (k *Conn) Open() bool { return !k.closing.Load() }

func (k *Conn) send(t websocket.MessageType, b []byte) bool {
	if !k.Open() {
		return false
	}
	select {
	case k.out <- frame{t, b}:
		return true
	default:
		k.Terminate()
		return false
	}
}

// Text one text frame
func (k *Conn) Text(s string) bool { return k.send(websocket.MessageText, []byte(s)) }

// TextBytes one text frame
func (k *Conn) TextBytes(b []byte) bool { return k.send(websocket.MessageText, b) }

// Binary one binary frame
func (k *Conn) Binary(b []byte) bool { return k.send(websocket.MessageBinary, b) }

// JSON one text frame of v
func (k *Conn) JSON(v any) bool { return k.send(websocket.MessageText, util.Marshal(v)) }

// Read the next message, binary true for a binary frame
func (k *Conn) Read() (data []byte, binary bool, err error) {
	t, b, err := k.c.Read(k.ctx)
	if err != nil {
		k.code.Store(int32(websocket.CloseStatus(err)))
		k.finish()
		return nil, false, err
	}
	return b, t == websocket.MessageBinary, nil
}

// OnClose run once when the socket goes, in order
func (k *Conn) OnClose(fn func()) {
	k.mu.Lock()
	k.onClose = append(k.onClose, fn)
	k.mu.Unlock()
}

// CloseCode the peer's close code, 1005 when none
func (k *Conn) CloseCode() int { return int(k.code.Load()) }

func (k *Conn) finish() {
	k.once.Do(func() {
		k.closing.Store(true)
		close(k.done)
		k.cancel()
		k.mu.Lock()
		fns := k.onClose
		k.mu.Unlock()
		for _, fn := range fns {
			fn()
		}
	})
}

// Close with a code, queued frames flushed first
func (k *Conn) Close(code int) {
	if !k.closing.CompareAndSwap(false, true) {
		return
	}
	go func() {
		deadline := time.Now().Add(2 * time.Second)
		for len(k.out) > 0 && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		k.c.Close(websocket.StatusCode(code), "")
		k.finish()
	}()
}

// Terminate the socket dropped at once
func (k *Conn) Terminate() {
	k.closing.Store(true)
	k.c.CloseNow()
	k.finish()
}

// Done closed once the socket is gone
func (k *Conn) Done() <-chan struct{} { return k.done }

// KeepAlive pings every Heartbeat, a socket that never answers dropped
func (k *Conn) KeepAlive() {
	go func() {
		t := time.NewTicker(Heartbeat)
		defer t.Stop()
		for {
			select {
			case <-k.done:
				return
			case <-t.C:
				ctx, cancel := context.WithTimeout(k.ctx, Heartbeat)
				err := k.c.Ping(ctx)
				cancel()
				if err != nil && !errors.Is(err, context.Canceled) {
					k.Terminate()
					return
				}
			}
		}
	}()
}

// StatusOf a read error's close code, -1 when it wasn't a close
func StatusOf(err error) int { return int(websocket.CloseStatus(err)) }
