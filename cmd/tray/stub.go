//go:build !((darwin && cgo) || windows)

// Phosphorus's menu bar and tray app, macOS (built with cgo) and Windows only;
// Linux hosts run phosphorus under systemd with `phos`
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "the Phosphorus tray runs on macOS and Windows; here, use phos")
	os.Exit(1)
}
