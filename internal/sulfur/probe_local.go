package sulfur

// this Windows computer's toolchains found and asked directly, with no script:
// a GUI app starting a hidden, encoded PowerShell is what antivirus reads as a
// dropper, so the local probe runs each tool itself; a remote host still gets
// windowsProbe over ssh, where this app starts nothing

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const toolTimeout = 15 * time.Second

// firstLine the first nonblank line of a tool's output, or "" when it won't run
func firstLine(name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), toolTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd)
	out, _ := cmd.CombinedOutput()
	for _, l := range strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return l
		}
	}
	return ""
}

// localWindowsProbe the lines windowsProbe prints, in the same order
func localWindowsProbe() string {
	var s strings.Builder
	fmt.Fprintf(&s, "O|Windows|%s\n", os.Getenv("PROCESSOR_ARCHITECTURE"))
	s.WriteString(visualStudioLines())
	found := make([]string, len(known))
	var wg sync.WaitGroup
	for i, k := range known {
		if k.ver == "" {
			continue
		}
		path, err := exec.LookPath(k.id)
		if err != nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			found[i] = fmt.Sprintf("T|%s|%s|%s\n", k.id, path, firstLine(path, strings.Fields(k.ver)...))
		}()
	}
	wg.Wait()
	for _, l := range found {
		s.WriteString(l)
	}
	if path, err := exec.LookPath("dotnet"); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), toolTimeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, path, "--list-sdks")
		hideWindow(cmd)
		out, _ := cmd.Output()
		for _, l := range strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n") {
			if f := strings.Fields(l); len(f) > 0 {
				s.WriteString("N|" + f[0] + "\n")
			}
		}
	}
	return s.String()
}

// visualStudioLines a V| line for each install vswhere lists
func visualStudioLines() string {
	vswhere := filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft Visual Studio", "Installer", "vswhere.exe")
	if _, err := os.Stat(vswhere); err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, vswhere, "-all", "-products", "*", "-format", "json")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	var installs []struct {
		DisplayName         string `json:"displayName"`
		InstallationVersion string `json:"installationVersion"`
		InstallationPath    string `json:"installationPath"`
	}
	if json.Unmarshal(out, &installs) != nil {
		return ""
	}
	exists := func(p string) string {
		if _, err := os.Stat(p); err != nil {
			return ""
		}
		return p
	}
	var s strings.Builder
	for _, i := range installs {
		p := i.InstallationPath
		msvc := []string{}
		if ents, err := os.ReadDir(filepath.Join(p, "VC", "Tools", "MSVC")); err == nil {
			for _, e := range ents {
				if e.IsDir() {
					msvc = append(msvc, e.Name())
				}
			}
		}
		sort.Strings(msvc)
		vcvars := exists(filepath.Join(p, `VC\Auxiliary\Build\vcvars64.bat`))
		cmake := exists(filepath.Join(p, `Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe`))
		fmt.Fprintf(&s, "V|%s|%s|%s|%s|%s|%s\n", i.DisplayName, i.InstallationVersion, p, vcvars, strings.Join(msvc, ","), cmake)
	}
	return s.String()
}
