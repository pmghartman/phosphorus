package main

import (
	"log"
	"runtime"

	"github.com/pmghartman/phosphorus/internal/elector"
	"github.com/pmghartman/phosphorus/internal/modeld"
	"github.com/pmghartman/phosphorus/internal/server"
)

// role run's children: the frontend, the model, the git elector
func role(cmd string, args []string) (int, bool) {
	// each line timed where the log is run's file, journald timing it on Linux
	if runtime.GOOS != "linux" {
		log.SetFlags(log.LstdFlags)
	}
	switch cmd {
	case "serve":
		return server.Main(), true
	case "model":
		return modeld.Main(), true
	case "elector":
		return elector.Main(), true
	}
	return 0, false
}
