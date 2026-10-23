package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/files"
	"github.com/pmghartman/phosphorus/internal/mcp"
	"github.com/pmghartman/phosphorus/internal/update"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
)

// a copy's whole run, a large file over a slow peer included
const transferWait = 30 * time.Minute

// localShare a share here, home only for a keyed caller and within their rights
func localShare(c *mcp.Caller, share string, rels ...string) (*files.Share, int, any) {
	if !files.Enabled() {
		return nil, 503, map[string]any{"error": selfHost + " publishes no files directory"}
	}
	sh := files.ShareOf(share)
	if sh == nil {
		return nil, 404, map[string]any{"error": selfHost + " has no such share"}
	}
	if sh.ID == "home" {
		if c == nil {
			return nil, 403, map[string]any{"error": "the homes are for their users only"}
		}
		who := &files.Who{User: c.User, Admin: c.Admin}
		for _, r := range rels {
			if why := files.HomeGate(who, r, users.Exists); why != "" {
				return nil, files.GateCode(who, why), map[string]any{"error": why}
			}
		}
	}
	return sh, 0, nil
}

// peerFiles a raw files request to a peer, the caller's rights sealed along
func peerFiles(ctx context.Context, c *mcp.Caller, host, op, method string, q url.Values, body io.Reader, size int64) (*http.Response, error) {
	ip := util.TailnetIP(host)
	if ip == "" {
		return nil, fmt.Errorf("can't find %s on the tailnet", host)
	}
	q.Set("hop", "1")
	u := fmt.Sprintf("http://%s:%d/api/files/%s/%s?%s", ip, util.FrontendPort, host, op, q.Encode())
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.ContentLength = size
	}
	if c != nil {
		req.Header.Set(whoHeader, users.SealGrant(map[string]any{"u": c.User, "a": c.Admin}, int64(transferWait/time.Millisecond)))
	}
	return http.DefaultClient.Do(req)
}

func errOf(res *http.Response) string {
	b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	if e := str(util.Obj(util.Decode(b))["error"]); e != "" {
		return e
	}
	return fmt.Sprintf("status %d", res.StatusCode)
}

// Loc a file on a host's share
type Loc struct{ Host, Share, Path string }

// copyAcross one file from a share to a share, any hosts, moved when move
func copyAcross(c *mcp.Caller, from, to Loc, move bool) (int, any) {
	if from == to {
		return 400, map[string]any{"error": "the same file"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), transferWait)
	defer cancel()
	var src io.ReadCloser
	var size int64
	if from.Host == selfHost {
		sh, st, b := localShare(c, from.Share, from.Path)
		if sh == nil {
			return st, b
		}
		abs := files.DownloadPath(sh, from.Path)
		if abs == "" {
			return 404, map[string]any{"error": "no such file (folders aren't copied)"}
		}
		f, err := os.Open(abs)
		if err != nil {
			return 500, map[string]any{"error": err.Error()}
		}
		fi, _ := f.Stat()
		src, size = f, fi.Size()
	} else {
		res, err := peerFiles(ctx, c, from.Host, "download", "GET", url.Values{"share": {from.Share}, "path": {from.Path}}, nil, 0)
		if err != nil {
			return 502, map[string]any{"error": err.Error()}
		}
		if res.StatusCode != 200 {
			defer res.Body.Close()
			return res.StatusCode, map[string]any{"error": errOf(res)}
		}
		src, size = res.Body, res.ContentLength
		if size < 0 {
			res.Body.Close()
			return 502, map[string]any{"error": from.Host + " sent no size"}
		}
	}
	defer src.Close()
	id := strings.ReplaceAll(update.UUID(), "-", "")
	var st int
	var out any
	if to.Host == selfHost {
		sh, s, b := localShare(c, to.Share, to.Path)
		if sh == nil {
			return s, b
		}
		st, out = files.Write(sh, to.Path, src, files.UploadQ{ID: id, Offset: float64(0), Total: float64(size)})
	} else {
		q := url.Values{"share": {to.Share}, "path": {to.Path}, "id": {id}, "offset": {"0"}, "total": {strconv.FormatInt(size, 10)}}
		res, err := peerFiles(ctx, c, to.Host, "upload", "POST", q, src, size)
		if err != nil {
			return 502, map[string]any{"error": err.Error()}
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return res.StatusCode, map[string]any{"error": errOf(res)}
		}
		st, out = 200, map[string]any{"ok": true, "path": to.Path}
	}
	if st != 200 || !move {
		return st, out
	}
	if dst, b := filesCall(c, from.Host, "delete", from.Share, map[string]any{"path": from.Path}); dst >= 300 {
		return 200, map[string]any{"ok": true, "path": to.Path, "note": "copied, the original left: " + str(util.Obj(b)["error"])}
	}
	return 200, map[string]any{"ok": true, "path": to.Path, "moved": true}
}
