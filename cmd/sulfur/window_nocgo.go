//go:build !windows && !cgo

package main

// runWindow with no window to draw: this build has no cgo, so Sulfur is opened in
// the system's browser and served until the process is stopped
func runWindow(url string) error {
	if err := openURL(url); err != nil {
		return err
	}
	select {}
}
