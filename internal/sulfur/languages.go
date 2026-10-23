package sulfur

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/code"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

// The same language host (languages_host.go) runs in this process for the
// desktop user, or as `phosphorus sulfur-language` under the saved SSH login on
// a mesh host. No daemon, system installation, PTY, or network is needed to
// launch an installed server.

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
	var in io.WriteCloser
	var out io.Reader
	var stop func()
	var wait func() error
	if remote == "" {
		inR, inW := io.Pipe()
		outR, outW := io.Pipe()
		done := make(chan struct{})
		go func() {
			// its error already sent down the socket
			ServeLanguage(request, inR, outW, &languageLog{ws: ws})
			outW.Close()
			close(done)
		}()
		in, out = inW, outR
		stop = func() { inW.Close() }
		wait = func() error { outR.Close(); <-done; inR.Close(); return nil }
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
		arg, _ := json.Marshal(request)
		line := "phosphorus sulfur-language " + base64.StdEncoding.EncodeToString(arg)
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
		exited := make(chan struct{})
		stop = func() {
			in.Close()
			time.AfterFunc(5*time.Second, func() {
				select {
				case <-exited:
				default:
					ss.Close()
					cl.Close()
				}
			})
		}
		wait = func() error { e := ss.Wait(); close(exited); cl.Close(); return e }
	}
	var once sync.Once
	closeProcess := func() { once.Do(stop) }
	defer closeProcess()
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
	closeProcess()
	if e := wait(); e != nil && ws.Open() {
		fail(e)
	}
}

type languageLog struct{ ws *wsock.Conn }

func (l *languageLog) Write(b []byte) (int, error) {
	l.ws.JSON(map[string]any{"_sulfur": "log", "text": string(b)})
	return len(b), nil
}
