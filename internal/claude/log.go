package claude

// a session's event log: one JSON message a line, each with its seq, the
// oldest dropped past logMax, read back from a seq on a socket's join

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	logMax = 5000
	// lineMax a line past this kept as a stub, its content too big to replay
	lineMax = 1 << 20
)

type evlog struct {
	mu    sync.Mutex
	file  string
	seq   int64
	lines int
}

// openLog the log at file, its last seq and line count read back
func openLog(file string) *evlog {
	l := &evlog{file: file}
	l.each(0, func(seq int64, _ []byte) {
		l.seq = max(l.seq, seq)
		l.lines++
	})
	return l
}

// each every line past since, in order
func (l *evlog) each(since int64, fn func(seq int64, line []byte)) {
	f, err := os.Open(l.file)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), lineMax*2)
	for sc.Scan() {
		b := sc.Bytes()
		var h struct {
			Seq int64 `json:"seq"`
		}
		if json.Unmarshal(b, &h) != nil || h.Seq <= since {
			continue
		}
		fn(h.Seq, append([]byte{}, b...))
	}
}

// add m logged under the next seq: the line as sent
func (l *evlog) add(m map[string]any) []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seq++
	m["seq"] = l.seq
	b := util.Marshal(m)
	if len(b) > lineMax {
		stub := map[string]any{"seq": l.seq, "kind": m["kind"], "truncated": true}
		if ev := util.Obj(m["ev"]); ev != nil {
			stub["ev"] = map[string]any{"type": ev["type"], "subtype": ev["subtype"]}
		}
		b = util.Marshal(stub)
	}
	os.MkdirAll(filepath.Dir(l.file), 0o700)
	f, err := os.OpenFile(l.file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err == nil {
		f.Write(append(b, '\n'))
		f.Close()
		l.lines++
	}
	if l.lines > logMax+logMax/10 {
		l.trim()
	}
	return b
}

// trim the oldest lines dropped, logMax kept; under l.mu
func (l *evlog) trim() {
	raw, err := os.ReadFile(l.file)
	if err != nil {
		return
	}
	lines := bytes.Split(bytes.TrimRight(raw, "\n"), []byte("\n"))
	if len(lines) > logMax {
		lines = lines[len(lines)-logMax:]
	}
	if writePrivate(l.file, append(bytes.Join(lines, []byte("\n")), '\n')) == nil {
		l.lines = len(lines)
	}
}

// last the newest seq
func (l *evlog) last() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.seq
}

func (l *evlog) remove() {
	l.mu.Lock()
	defer l.mu.Unlock()
	os.Remove(l.file)
}

// writePrivate temp then rename, owner only
func writePrivate(file string, b []byte) error {
	os.MkdirAll(filepath.Dir(file), 0o700)
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}
