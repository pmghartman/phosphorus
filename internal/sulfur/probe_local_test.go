package sulfur

import (
	"os/exec"
	"runtime"
	"testing"
)

func TestLocalWindowsProbeFindsWhatIsOnPath(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows only")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go on PATH")
	}
	tc := parseProbe(localWindowsProbe())
	if tc.OS != "windows" {
		t.Fatalf("os = %q", tc.OS)
	}
	for _, tool := range tc.Tools {
		if tool.ID == "go" && tool.Version != "" {
			return
		}
	}
	t.Fatalf("go not found in %+v", tc.Tools)
}
