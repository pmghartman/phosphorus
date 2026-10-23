package collab

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/files"
)

// One watcher per host, only while editors are attached. Unchanged files cost
// metadata checks; contents are read only after a change or before a save.
var diskWatchRunning bool // protected by mu

func diskStat(share files.Share, rel string) os.FileInfo {
	path := files.SafePath(share, rel, true)
	if path == "" {
		return nil
	}
	info, _ := os.Stat(path)
	return info
}

func sameDisk(a, b os.FileInfo) bool {
	return a != nil && b != nil && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime()) && os.SameFile(a, b)
}

type diskSnapshot struct {
	info          os.FileInfo
	text, problem string
	valid         bool
}

func readDisk(share files.Share, rel string) diskSnapshot {
	before := diskStat(share, rel)
	status, value := files.Read(&share, rel)
	after := diskStat(share, rel)
	result := diskSnapshot{info: after, valid: true}
	if status != 200 {
		result.problem = "The file is unavailable on disk. The editor version has been preserved."
		return result
	}
	// Retry an atomic replacement or an active write.
	if !sameDisk(before, after) {
		result.valid = false
		return result
	}
	// External editors can truncate and refill a file in several writes. Wait
	// for a quiet moment rather than publishing an intermediate empty buffer.
	if time.Since(after.ModTime()) < 150*time.Millisecond {
		result.valid = false
		return result
	}
	body, _ := value.(map[string]any)
	text, ok := body["text"].(string)
	if !ok {
		result.problem = "The disk file is binary or too large to reload. The editor version has been preserved."
		return result
	}
	result.text = text
	return result
}

func startDiskWatch() {
	if diskWatchRunning {
		return
	}
	diskWatchRunning = true
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for range ticker.C {
			type probe struct {
				s          *session
				info       os.FileInfo
				version    int
				problem    string
				generation uint64
			}
			mu.Lock()
			var probes []probe
			for _, s := range sessions {
				if len(s.clients) > 0 {
					probes = append(probes, probe{s, s.diskInfo, s.version, s.diskProblem, s.diskGeneration})
				}
			}
			if len(probes) == 0 {
				diskWatchRunning = false
				mu.Unlock()
				return
			}
			mu.Unlock()
			for _, p := range probes {
				info := diskStat(p.s.share, p.s.rel)
				if sameDisk(p.info, info) || info == nil && p.problem != "" {
					continue
				}
				observed := readDisk(p.s.share, p.s.rel)
				mu.Lock()
				if sessions[p.s.key] == p.s && len(p.s.clients) > 0 && p.s.version == p.version && p.s.diskGeneration == p.generation {
					p.s.observeDisk(observed)
				}
				mu.Unlock()
			}
		}
	}()
}

func diskDiff(before, after []uint16) []Op {
	start, tail := 0, 0
	for start < len(before) && start < len(after) && before[start] == after[start] {
		start++
	}
	// Inserted strings cross JSON as Unicode: never split a surrogate pair at
	// the retained prefix/suffix, even when two emoji share one surrogate.
	if start > 0 && start < len(before) && before[start] >= 0xDC00 && before[start] <= 0xDFFF {
		start--
	}
	for tail < len(before)-start && tail < len(after)-start && before[len(before)-1-tail] == after[len(after)-1-tail] {
		tail++
	}
	if tail > 0 && tail < len(after)-start && after[len(after)-tail] >= 0xDC00 && after[len(after)-tail] <= 0xDFFF {
		tail--
	}
	var b builder
	b.retain(start)
	b.insert(after[start : len(after)-tail])
	b.del(len(before) - start - tail)
	b.retain(tail)
	return nonNil(b.ops)
}

func (s *session) diskMessage() map[string]any {
	return map[string]any{"type": "disk", "conflict": s.diskConflict, "text": s.diskPending, "problem": s.diskProblem, "revision": s.diskRevision}
}

// Called under mu; disk changes use normal OT operations so pending client
// keystrokes, carets, undo history and language-server versions stay aligned.
func (s *session) observeDisk(snapshot diskSnapshot) {
	if !snapshot.valid {
		return
	}
	text := lf(snapshot.text)
	if s.diskConflict && s.diskPending == text && s.diskProblem == snapshot.problem && (sameDisk(s.diskInfo, snapshot.info) || s.diskInfo == nil && snapshot.info == nil) {
		return
	}
	s.diskInfo = snapshot.info
	s.diskGeneration++
	current := Str(s.text)
	if snapshot.problem == "" && (text == s.diskText || text == current) {
		was := s.diskConflict
		s.diskConflict, s.diskProblem = false, ""
		s.diskPending = ""
		// the disk's line ending, unless one chosen in the editor is waiting to be written
		if s.eolPending {
		} else if strings.Contains(snapshot.text, "\r\n") {
			s.eol = "\r\n"
		} else {
			s.eol = "\n"
		}
		if text == current && s.saved != s.version {
			s.diskText = text
			s.saved = s.version
			s.toAll(map[string]any{"type": "saved", "v": s.version, "by": "disk"})
		}
		if was {
			s.toAll(s.diskMessage())
			if s.saved != s.version {
				s.saveSoon()
			}
		}
		return
	}
	if snapshot.problem != "" || s.saved != s.version {
		s.diskConflict = true
		s.diskPending = text
		s.diskProblem = snapshot.problem
		s.diskRevision++
		s.diskCRLF = strings.Contains(snapshot.text, "\r\n")
		if s.autosave != nil {
			s.autosave.Stop()
		}
		s.toAll(s.diskMessage())
		return
	}
	s.applyDiskText(text)
	// another program's save wins over a line ending chosen and not yet written
	s.eolPending = false
	if strings.Contains(snapshot.text, "\r\n") {
		s.eol = "\r\n"
	} else {
		s.eol = "\n"
	}
}

func (s *session) applyDiskText(text string) {
	next := U16(text)
	ops := diskDiff(s.text, next)
	s.text = next
	s.version++
	s.history = append(s.history, ops)
	if len(s.history) > history {
		s.history = s.history[1:]
	}
	for _, c := range s.order {
		c.pos = MapPos(ops, c.pos)
	}
	s.diskText = text
	s.diskConflict, s.diskProblem = false, ""
	s.saved = s.version
	s.diskPending = ""
	s.toAll(map[string]any{"type": "op", "v": s.version, "ops": ops, "by": "disk"})
	s.toAll(map[string]any{"type": "saved", "v": s.version, "by": "disk"})
	s.toAll(s.diskMessage())
}

func (s *session) resolveDisk(c *client, msg map[string]any) {
	if !s.diskConflict {
		return
	}
	revision, ok := msg["revision"].(float64)
	observed := readDisk(s.share, s.rel)
	if !observed.valid {
		return
	}
	s.observeDisk(observed)
	if !ok || revision != float64(s.diskRevision) {
		sendTo(c, s.diskMessage())
		return
	}
	if !s.diskConflict {
		return
	}
	switch msg["choice"] {
	case "reload":
		if s.diskProblem == "" {
			if s.diskCRLF {
				s.eol = "\r\n"
			} else {
				s.eol = "\n"
			}
			s.applyDiskText(s.diskPending)
		}
	case "keep":
		if !files.Can(&s.share, "w") {
			return
		}
		s.diskConflict = false
		// The user reviewed this exact disk revision, including a deleted file.
		status, _ := s.saveDisk("editor", true)
		if status != 200 {
			s.diskConflict = true
			sendTo(c, map[string]any{"type": "error", "error": fmt.Sprintf("save failed (%d); both versions retained", status)})
		}
		s.toAll(s.diskMessage())
	}
}
