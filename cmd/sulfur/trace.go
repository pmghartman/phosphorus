package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

var started = time.Now()

// trace a startup step and its time since launch, appended to sulfur-startup.log in the temp folder
// when SULFUR_TRACE is set
func trace(step string) {
	if os.Getenv("SULFUR_TRACE") == "" {
		return
	}
	f, err := os.OpenFile(filepath.Join(os.TempDir(), "sulfur-startup.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%7.0f ms  %s\n", float64(time.Since(started).Microseconds())/1000, step)
}
