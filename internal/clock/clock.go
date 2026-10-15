// Package clock: the one cadence for every loop and the state push, fast
// while anything moves, idle once it settles
package clock

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	FastMS = util.EnvInt("POLL_INTERVAL_MS", 100)
	IdleMS = util.EnvInt("IDLE_POLL_INTERVAL_MS", 500)
	// how long one piece of news holds the fast rate
	HotMS = util.EnvInt("POLL_HOT_MS", 3000)

	hotUntil  atomic.Int64
	mu        sync.Mutex
	listeners []func()
)

// OnHot woken on every piece of news
func OnHot(fn func()) {
	mu.Lock()
	listeners = append(listeners, fn)
	mu.Unlock()
}

// MarkHot news: the fast rate for HotMS
func MarkHot() {
	hotUntil.Store(util.Now() + int64(HotMS))
	mu.Lock()
	ls := append([]func(){}, listeners...)
	mu.Unlock()
	for _, fn := range ls {
		fn()
	}
}

// IsHot while news is fresh
func IsHot() bool { return util.Now() < hotUntil.Load() }

// IntervalMS the current loop interval
func IntervalMS() int {
	if IsHot() {
		return FastMS
	}
	return IdleMS
}

// Interval as a duration
func Interval() time.Duration { return time.Duration(IntervalMS()) * time.Millisecond }
