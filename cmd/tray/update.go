//go:build (darwin && cgo) || windows

package main

// the app's own updates: the signed feed's newer release, installed in this one's place

import "github.com/pmghartman/phosphorus/internal/appfeed"

func feed() appfeed.Feed { return appfeed.Feed{URL: feedURL, Pubkey: feedPubkey} }

// the feed's release when newer than this app, nil when not or with no feed (a dev build)
func feedCheck() (*appfeed.Release, error) {
	have := appVersion
	if have == "" {
		have = payloadVersion()
	}
	return feed().Check(have)
}

// installRelease downloaded, its signature checked, then handed to this OS's installer
func installRelease(r *appfeed.Release) error {
	f, err := feed().Fetch(r)
	if err != nil {
		return err
	}
	return installDownloaded(f)
}
