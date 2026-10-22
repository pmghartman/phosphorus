package code

// a page's socket on a session: the log replayed past since, then live

import (
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

// Attach a socket to the user's session till it goes, false for no such session
func Attach(c conn, done <-chan struct{}, user, id string, since int64) bool {
	s := of(user, id)
	if s == nil {
		return false
	}
	x := &sub{c: c}
	s.mu.Lock()
	if s.deleted {
		s.mu.Unlock()
		return false
	}
	s.subs[c] = x
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subs, c)
		s.mu.Unlock()
	}()
	top := since
	s.log.each(since, func(seq int64, line []byte) {
		for c.Open() && c.Queued() > queueHigh {
			time.Sleep(10 * time.Millisecond)
		}
		if c.Open() {
			c.TextBytes(line)
			top = max(top, seq)
		}
	})
	s.mu.Lock()
	for i, b := range x.backlog {
		// a line logged while the replay read the file sent once
		if q := x.seqs[i]; q == 0 || q > top {
			c.TextBytes(b)
		}
	}
	x.backlog, x.seqs, x.ready = nil, nil, true
	b := util.Marshal(map[string]any{"seq": 0, "kind": "status", "record": s.rec})
	c.TextBytes(b)
	s.mu.Unlock()
	<-done
	return true
}
