package main

import (
	"github.com/pmghartman/phosphorus/internal/elector"
	"github.com/pmghartman/phosphorus/internal/modeld"
	"github.com/pmghartman/phosphorus/internal/server"
	"github.com/pmghartman/phosphorus/internal/sshrelay"
)

// role the container's, Linux only
func role(cmd string, args []string) (int, bool) {
	switch cmd {
	case "serve":
		return server.Main(), true
	case "model":
		return modeld.Main(), true
	case "elector":
		return elector.Main(), true
	case "ssh-relay":
		return sshrelay.ProxyMain(args), true
	}
	return 0, false
}
