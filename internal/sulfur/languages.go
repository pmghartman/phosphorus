package sulfur

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/code"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

// The same small host adapter runs under the desktop user or the saved SSH
// login. No daemon, system installation, PTY, or network is needed to launch an
// installed server. Python is an explicit prerequisite, never auto-installed.
//
//go:embed languages.py
var languageHelper string

type LanguageRequest struct {
	Op             string `json:"op"`
	Language       string `json:"language"`
	Root           string `json:"root"`
	Configuration  string `json:"configuration"`
	BuildDirectory string `json:"buildDirectory"`
}

// LanguageSocket serves one management operation or one project's LSP session.
// A socket's lifetime owns its subprocess and all its document versions.
func LanguageSocket(ws *wsock.Conn, remote string, creds code.Creds) {
	defer ws.Close(1000)
	fail := func(err error) { ws.JSON(map[string]any{"_sulfur": "error", "error": err.Error()}) }
	b, _, err := ws.Read()
	if err != nil {
		return
	}
	var request LanguageRequest
	if len(b) > 32768 || json.Unmarshal(b, &request) != nil {
		fail(errors.New("invalid language request"))
		return
	}
	if request.Op != "status" && request.Op != "install" && request.Op != "enable" && request.Op != "disable" && request.Op != "uninstall" && request.Op != "launch" {
		fail(errors.New("unknown language operation"))
		return
	}
	arg, _ := json.Marshal(request)
	payload := base64.StdEncoding.EncodeToString(arg)
	var packed bytes.Buffer
	z := zlib.NewWriter(&packed)
	z.Write([]byte(languageHelper))
	z.Close()
	// Send the adapter over stdin to stay below Windows sshd/cmd command limits.
	bootstrap := "import sys,base64,zlib;exec(zlib.decompress(base64.b64decode(sys.stdin.buffer.readline())))"
	exited := make(chan struct{})
	killLater := func(kill func()) {
		time.AfterFunc(5*time.Second, func() {
			select {
			case <-exited:
				return
			default:
				kill()
			}
		})
	}
	var in io.WriteCloser
	var out io.Reader
	var stop func()
	var wait func() error
	if remote == "" {
		python := ""
		for _, name := range []string{"python3", "python", "py"} {
			p, e := exec.LookPath(name)
			if e != nil {
				continue
			}
			if strings.Contains(strings.ToLower(p), `microsoft\windowsapps`) {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			probe := exec.CommandContext(ctx, p, "-c", "import sys;assert sys.version_info >= (3,10)")
			hideWindow(probe)
			e = probe.Run()
			cancel()
			if e == nil {
				python = p
				break
			}
		}
		if python == "" {
			fail(errors.New("Install Python 3.10+ on this host and add it to PATH, then retry"))
			return
		}
		cmd := exec.Command(python, "-u", "-c", bootstrap, payload)
		hideWindow(cmd)
		in, err = cmd.StdinPipe()
		if err == nil {
			out, err = cmd.StdoutPipe()
		}
		cmd.Stderr = &languageLog{ws: ws}
		if err == nil {
			err = cmd.Start()
		}
		if err != nil {
			fail(err)
			return
		}
		stop = func() {
			in.Close()
			killLater(func() {
				if runtime.GOOS == "windows" {
					killTree(cmd.Process)
				} else {
					cmd.Process.Kill()
				}
			})
		}
		wait = func() error { e := cmd.Wait(); close(exited); return e }
	} else {
		cl, e := code.Dial(remote, creds)
		if e != nil {
			fail(e)
			return
		}
		win, e := isWindows(cl)
		if e != nil {
			cl.Close()
			fail(e)
			return
		}
		python := ""
		for _, name := range []string{"python3", "python", "py"} {
			probe := name + ` -c "import sys;assert sys.version_info >= (3,10);print('SULFUR_PYTHON_OK')"`
			if !win {
				probe = "sh -c " + code.Quote(posixPath+probe)
			}
			if result, e := output(cl, probe, 15*time.Second); e == nil && strings.Contains(result, "SULFUR_PYTHON_OK") {
				python = name
				break
			}
		}
		if python == "" {
			cl.Close()
			fail(errors.New("Install Python 3.10+ on the project host and add it to the SSH login's PATH"))
			return
		}
		ss, e := cl.NewSession()
		if e != nil {
			cl.Close()
			fail(e)
			return
		}
		in, err = ss.StdinPipe()
		if err == nil {
			out, err = ss.StdoutPipe()
		}
		ss.Stderr = &languageLog{ws: ws}
		line := python + " -u -c " + code.Quote(bootstrap) + " " + code.Quote(payload)
		if win {
			line = PowerShell("& " + python + " -u -c '" + strings.ReplaceAll(bootstrap, "'", "''") + "' '" + payload + "'")
		}
		if !win {
			line = "sh -c " + code.Quote(posixPath+line)
		}
		if err == nil {
			err = ss.Start(line)
		}
		if err != nil {
			cl.Close()
			fail(err)
			return
		}
		stop = func() { in.Close(); killLater(func() { ss.Close(); cl.Close() }) }
		wait = func() error { e := ss.Wait(); close(exited); cl.Close(); return e }
	}
	var once sync.Once
	closeProcess := func() { once.Do(stop) }
	defer closeProcess()
	if _, err = in.Write([]byte(base64.StdEncoding.EncodeToString(packed.Bytes()) + "\n")); err != nil {
		closeProcess()
		fail(err)
		return
	}
	go func() {
		for {
			b, _, e := ws.Read()
			if e != nil {
				closeProcess()
				return
			}
			if len(b) > 16<<20 || !json.Valid(b) {
				closeProcess()
				return
			}
			if _, e = in.Write(append(b, '\n')); e != nil {
				closeProcess()
				return
			}
		}
	}()
	scan := bufio.NewScanner(out)
	scan.Buffer(make([]byte, 65536), 32<<20)
	for scan.Scan() {
		if !ws.TextBytes(append([]byte(nil), scan.Bytes()...)) {
			break
		}
	}
	if e := scan.Err(); e != nil {
		closeProcess()
		fail(e)
	}
	if e := wait(); e != nil && ws.Open() {
		fail(e)
	}
}

type languageLog struct{ ws *wsock.Conn }

func (l *languageLog) Write(b []byte) (int, error) {
	l.ws.JSON(map[string]any{"_sulfur": "log", "text": string(b)})
	return len(b), nil
}
