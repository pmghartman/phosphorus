package sulfur

import (
	"os"
	"strings"
	"testing"
)

// SULFUR_PRINT=1 prints the probe commands, to try by hand on a host
func TestPrintProbes(t *testing.T) {
	if os.Getenv("SULFUR_PRINT") == "" {
		t.Skip("SULFUR_PRINT unset")
	}
	os.WriteFile(os.Getenv("SULFUR_PRINT")+"/posix.sh", []byte(posixProbe()), 0o644)
	os.WriteFile(os.Getenv("SULFUR_PRINT")+"/windows.cmd", []byte(PowerShell(windowsProbe())), 0o644)
}

func TestTaskLine(t *testing.T) {
	l, err := Task{Dir: "/srv/data/it's here", Command: "make -j4 && ./a.out"}.Line()
	if err != nil || !strings.Contains(l, `'/srv/data/it'\''s here'`) || !strings.Contains(l, `'make -j4 && ./a.out'`) {
		t.Fatal(l, err)
	}
	l, err = Task{Windows: true, Dir: `D:\Projects\app`, VCVars: `C:\VS\vcvars64.bat`, Command: `cmake --build build --config Debug`}.Line()
	want := `cmd /d /s /c "pushd "D:\Projects\app" && call "C:\VS\vcvars64.bat" >nul && cmake --build build --config Debug"`
	if err != nil || l != want {
		t.Fatalf("%s\n%s %v", l, want, err)
	}
	for _, bad := range []Task{{Dir: "/x", Command: ""}, {Dir: "/x", Command: "a\nb"}, {Windows: true, Dir: `D:\a"b`, Command: "dir"}} {
		if _, err := bad.Line(); err == nil {
			t.Fatalf("%+v taken", bad)
		}
	}
}

func TestVersion(t *testing.T) {
	for in, want := range map[string]string{
		"gcc (Debian 14.2.0-19) 14.2.0":       "14.2.0",
		"go version go1.26.10 linux/amd64":    "1.26.10",
		"v22.11.0":                            "22.11.0",
		"cmake version 4.1.2":                 "4.1.2",
		"Python 3.13.5":                       "3.13.5",
		"10.0.302":                            "10.0.302",
		"cargo 1.90.0 (840b83a10 2025-07-30)": "1.90.0",
		"git version 2.47.3":                  "2.47.3",
	} {
		if got := version(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestParseProbe(t *testing.T) {
	out := "O|Windows|AMD64\r\n" +
		"V|Visual Studio Community 2026|18.0.11|C:\\VS\\18\\Community|C:\\VS\\18\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat|14.44.35207,14.50.35717\r\n" +
		"T|dotnet|C:\\Program Files\\dotnet\\dotnet.exe|10.0.302\r\n" +
		"T|python|C:\\Users\\r\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe|Python was not found\r\n" +
		"T|cmake|C:\\Program Files\\CMake\\bin\\cmake.exe|cmake version 4.1.2\r\n" +
		"N|8.0.408\r\nN|10.0.302\r\n"
	tc := parseProbe(out)
	if tc.OS != "windows" || tc.Arch != "amd64" || len(tc.VS) != 1 || tc.VS[0].MSVC[0] != "14.50.35717" || len(tc.Dotnet) != 2 {
		t.Fatalf("%+v", tc)
	}
	ids := []string{}
	for _, x := range tc.Tools {
		ids = append(ids, x.ID+"="+x.Version)
	}
	if strings.Join(ids, " ") != "dotnet=10.0.302 cmake=4.1.2" {
		t.Fatal(ids)
	}
}
