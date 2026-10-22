package code

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// the probe's lines off a PATH holding a fake opencode and no claude
func TestProbeCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh scripts")
	}
	home := t.TempDir()
	bin := filepath.Join(home, ".opencode", "bin")
	os.MkdirAll(bin, 0o755)
	os.WriteFile(filepath.Join(bin, "opencode"), []byte("#!/bin/sh\necho 1.2.3\n"), 0o755)
	cmd := probeCommand()
	c := exec.Command("sh", "-c", cmd)
	c.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
	out, err := c.Output()
	if err != nil {
		t.Fatal(err, string(out))
	}
	got := strings.TrimSpace(string(out))
	if !strings.Contains(got, "claude\t0\t") || !strings.Contains(got, "opencode\t1\t1.2.3") {
		t.Fatalf("probe said %q", got)
	}
}

func TestHarnessByID(t *testing.T) {
	if harnessByID(Opencode) == nil || !harnessByID(Opencode).MeshOnly || harnessByID("nope") != nil {
		t.Fatal("registry")
	}
	if harnessOf(Record{}) != Claude {
		t.Fatal("old records run claude")
	}
}

func TestParseProbe(t *testing.T) {
	st := parseProbe("claude\t1\t\r\nopencode\t0\t\nnoise\n")
	if len(st) != len(Harnesses) || !st[0].Installed || st[0].Version != "" || st[1].Installed {
		t.Fatalf("parsed %+v", st)
	}
}
