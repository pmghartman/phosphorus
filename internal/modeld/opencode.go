package modeld

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/pmghartman/phosphorus/internal/tools"
	"github.com/pmghartman/phosphorus/internal/util"
)

// opencode as the frontend's run file asks, started and stopped here
var oc struct {
	want []byte
	gen  string
	proc *exec.Cmd
}

const ocTick = 250 * time.Millisecond

func ocState(gen, err string) {
	util.WriteJSONAtomic(tools.OpencodeStateFile(), tools.OpencodeState{Gen: gen, Err: err})
}

func ocStop() {
	mu.Lock()
	p := oc.proc
	oc.proc, oc.gen = nil, ""
	mu.Unlock()
	if p == nil || p.Process == nil {
		return
	}
	p.Process.Signal(syscall.SIGTERM)
	done := make(chan struct{})
	go func() { p.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		p.Process.Kill()
		<-done
	}
}

func ocStart(r tools.OpencodeRun) {
	cmd := exec.Command(tools.OpencodeBin(), r.Args...)
	cmd.Dir = r.Dir
	cmd.Env = append(append(os.Environ(), r.Env...), "PHOSPHORUS_ROLE=opencode")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		notes.Log("opencode didn't start: " + err.Error())
		ocState(r.Gen, "didn't start: "+err.Error())
		return
	}
	mu.Lock()
	oc.proc, oc.gen = cmd, r.Gen
	mu.Unlock()
	notes.Log("opencode started")
	ocState(r.Gen, "")
	go func() {
		err := cmd.Wait()
		why := "exited"
		if err != nil {
			why = "exited: " + err.Error()
		}
		mu.Lock()
		mine := oc.proc == cmd
		if mine {
			oc.proc = nil
		}
		mu.Unlock()
		if mine {
			notes.Log("opencode " + why)
			ocState(r.Gen, why)
		}
	}()
}

// the run file followed: a new gen restarts it, none stops it
func ocWatch() {
	for range time.Tick(ocTick) {
		b, _ := os.ReadFile(tools.OpencodeRunFile())
		if bytes.Equal(b, oc.want) {
			continue
		}
		oc.want = b
		var r tools.OpencodeRun
		json.Unmarshal(b, &r)
		mu.Lock()
		same := r.Gen != "" && r.Gen == oc.gen
		mu.Unlock()
		if same {
			continue
		}
		ocStop()
		if r.Gen != "" {
			ocStart(r)
		} else {
			notes.Log("opencode stopped")
		}
	}
}
