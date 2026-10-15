// Package ini reads phosphorus.ini the way util.js did: first key wins,
// quotes stripped, ; and # comment lines, re-parsed only on a stat change.
package ini

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
)

// File is one ini file, cached by its stat signature.
type File struct {
	Path string
	mu   sync.Mutex
	sig  string
	keys map[string]string
}

var (
	commentRe = regexp.MustCompile(`^\s*[;#]`)
	headRe    = regexp.MustCompile(`^\s*\[\s*(.+?)\s*\]\s*$`)
	kvRe      = regexp.MustCompile(`^\s*([^=]+?)\s*=\s*(.*?)\s*$`)
	quoteRe   = regexp.MustCompile(`^"|"$`)
)

// Parse maps "section\x00key" to value, the first occurrence kept.
func Parse(text string) map[string]string {
	keys := map[string]string{}
	current := ""
	for _, line := range splitLines(text) {
		if commentRe.MatchString(line) {
			continue
		}
		if m := headRe.FindStringSubmatch(line); m != nil {
			current = m[1]
			continue
		}
		m := kvRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		k := current + "\x00" + m[1]
		if _, ok := keys[k]; !ok {
			keys[k] = quoteRe.ReplaceAllString(m[2], "")
		}
	}
	return keys
}

// splitLines splits on \n or \r\n, as /\r?\n/
func splitLines(text string) []string {
	parts := strings.Split(text, "\n")
	for i, p := range parts {
		parts[i] = strings.TrimSuffix(p, "\r")
	}
	return parts
}

// Get one key, blank when unset or the file is unreadable.
func (f *File) Get(section, key string) string {
	st, err := os.Stat(f.Path)
	if err != nil {
		return ""
	}
	sig := fmt.Sprintf("%v:%d:%d", inode(st), st.Size(), st.ModTime().UnixNano())
	f.mu.Lock()
	defer f.mu.Unlock()
	if sig != f.sig || f.keys == nil {
		b, _ := os.ReadFile(f.Path)
		f.keys = Parse(string(b))
		f.sig = sig
	}
	return f.keys[section+"\x00"+key]
}
