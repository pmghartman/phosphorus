// phosphorus: one binary for every role, run's children (serve | model | elector |
// cli) and the host's (install, start, stop, keys and the rest)
package main

import (
	"fmt"
	"log"
	"os"

	"github.com/pmghartman/phosphorus/internal/cli"
	"github.com/pmghartman/phosphorus/internal/host"
)

func main() {
	log.SetFlags(0)
	cmd, args := "", []string{}
	if len(os.Args) > 1 {
		cmd, args = os.Args[1], os.Args[2:]
	}
	switch {
	case cmd == "cli":
		os.Exit(cli.Main(args))
	case cmd == "version":
		fmt.Println(host.Version())
	case host.Commands[cmd]:
		os.Exit(host.Main(cmd, args))
	default:
		if code, ok := role(cmd, args); ok {
			os.Exit(code)
		}
		fmt.Fprintln(os.Stderr, "usage: phosphorus [start | stop | restart | update [all] | keys | help]")
		os.Exit(2)
	}
}
