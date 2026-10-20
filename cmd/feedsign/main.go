// feedsign: the release's app updates signed for the feed, each FILE's
// signature written to FILE.sig, with the key in UPDATE_SIGNING_KEY; -keygen
// prints a fresh pair for the repo's secret and variable, no password to keep
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/pmghartman/phosphorus/internal/minisign"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "-keygen" {
		sec, pub, err := minisign.Generate()
		if err != nil {
			fmt.Fprintln(os.Stderr, "feedsign:", err)
			os.Exit(1)
		}
		fmt.Printf("secret UPDATE_SIGNING_KEY:\n%s\n\nvariable UPDATE_PUBKEY:\n%s\n", sec, pub)
		return
	}
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: feedsign FILE... | feedsign -keygen")
		os.Exit(2)
	}
	key := os.Getenv("UPDATE_SIGNING_KEY")
	if minisign.Encrypted(key) {
		fmt.Fprintln(os.Stderr, "feedsign: UPDATE_SIGNING_KEY is password protected; make a new one with feedsign -keygen")
		os.Exit(1)
	}
	k, err := minisign.ParseSecretKey(key, "")
	if err != nil {
		fmt.Fprintln(os.Stderr, "feedsign:", err)
		os.Exit(1)
	}
	// the key the installed apps check against, when the release names it
	if pub := os.Getenv("FEED_PUBKEY"); pub != "" {
		if p, err := minisign.ParsePublicKey(pub); err != nil || p.ID != k.ID {
			fmt.Fprintln(os.Stderr, "feedsign: UPDATE_SIGNING_KEY isn't the key UPDATE_PUBKEY names; installed apps would refuse its updates")
			os.Exit(1)
		}
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
