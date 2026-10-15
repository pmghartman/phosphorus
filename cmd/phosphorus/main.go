// phosphorus: one binary for every role, serve | model | elector | cli | ssh-relay
package main

import (
	"fmt"
	"log"
	"os"

	"github.com/pmghartman/phosphorus/internal/cli"
	"github.com/pmghartman/phosphorus/internal/elector"
	"github.com/pmghartman/phosphorus/internal/modeld"
	"github.com/pmghartman/phosphorus/internal/server"
	"github.com/pmghartman/phosphorus/internal/sshrelay"
)

func usage() {
	fmt.Fprintln(os.Stderr, "usage: phosphorus serve | model | elector | cli [args] | ssh-relay <host> <port> | version")
}

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	args := os.Args[2:]
	switch os.Args[1] {
	case "serve":
		os.Exit(server.Main())
	case "model":
		os.Exit(modeld.Main())
	case "elector":
		os.Exit(elector.Main())
	case "cli":
		os.Exit(cli.Main(args))
	case "ssh-relay":
		os.Exit(sshrelay.ProxyMain(args))
	case "version":
		fmt.Println(server.Version())
	default:
		usage()
		os.Exit(2)
	}
}
