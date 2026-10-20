// feedsign: the release's app updates signed for the feed, each FILE's
// signature written to FILE.sig; the minisign key in UPDATE_SIGNING_KEY, its
// password in UPDATE_SIGNING_KEY_PASSWORD
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/pmghartman/phosphorus/internal/minisign"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: feedsign FILE...")
		os.Exit(2)
	}
	k, err := minisign.ParseSecretKey(os.Getenv("UPDATE_SIGNING_KEY"), os.Getenv("UPDATE_SIGNING_KEY_PASSWORD"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "feedsign:", err)
		os.Exit(1)
	}
	for _, f := range os.Args[1:] {
		b, err := os.ReadFile(f)
		if err == nil {
			err = os.WriteFile(f+".sig", []byte(k.Sign(b, filepath.Base(f))), 0o644)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "feedsign:", err)
			os.Exit(1)
		}
		fmt.Println("signed", f)
	}
}
