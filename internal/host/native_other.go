//go:build !linux

package host

import (
	"io"
	"time"
)

// native Linux alone: macOS and Windows hosts stay on docker
func native() bool { return false }

func nativeRebuild() error            { return fail("native hosts are Linux only") }
func nativeUp() bool                  { return false }
func nativeStop() error               { return fail("native hosts are Linux only") }
func nativeRestart() error            { return fail("native hosts are Linux only") }
func nativeAttach([]string) error     { return fail("native hosts are Linux only") }
func runHost() error                  { return fail("phosphorus run is Linux only") }
func psHost(io.Writer) error          { return fail("phosphorus ps is Linux only") }
func waitFrontend(time.Duration) bool { return false }
