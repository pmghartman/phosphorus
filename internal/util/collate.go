package util

import (
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

var (
	collMu sync.Mutex
	coll   = collate.New(language.Und)
)

// LocaleCompare as String.prototype.localeCompare under ICU's root order
func LocaleCompare(a, b string) int {
	collMu.Lock()
	defer collMu.Unlock()
	if c := coll.CompareString(a, b); c != 0 {
		return c
	}
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
