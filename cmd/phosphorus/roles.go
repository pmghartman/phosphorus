package main

import (
	"github.com/pmghartman/phosphorus/internal/elector"
	"github.com/pmghartman/phosphorus/internal/modeld"
	"github.com/pmghartman/phosphorus/internal/server"
)

// role run's children: the frontend, the model, the git elector
func role(cmd string, args []string) (int, bool) {
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
