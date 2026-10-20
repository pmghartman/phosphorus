// feedsign: the release's app updates signed for the feed, each FILE's
// signature written to FILE.sig; the minisign key in UPDATE_SIGNING_KEY, its
// password in UPDATE_SIGNING_KEY_PASSWORD
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/pmghartman/phosphorus/internal/minisign"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: feedsign FILE...")
		os.Exit(2)
	}
	key, pass := os.Getenv("UPDATE_SIGNING_KEY"), os.Getenv("UPDATE_SIGNING_KEY_PASSWORD")
	k, err := minisign.ParseSecretKey(key, pass)
	// a secret pasted with a line break or space around it
	if t := strings.TrimSpace(pass); err != nil && t != pass {
		k, err = minisign.ParseSecretKey(key, t)
	}
	if err != nil {
		why := err.Error()
		switch {
		case minisign.Encrypted(key) && pass == "":
			why = "the key is encrypted and UPDATE_SIGNING_KEY_PASSWORD is empty"
		case minisign.Encrypted(key):
			why = fmt.Sprintf("UPDATE_SIGNING_KEY_PASSWORD (%d characters) doesn't open UPDATE_SIGNING_KEY: not the password this key was made with", len(pass))
		}
		fmt.Fprintln(os.Stderr, "feedsign:", why)
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
