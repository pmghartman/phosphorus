package sulfur

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func vsxTestRegistry(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	previous := vsxClient
	vsxClient = server.Client()
	t.Setenv("SULFUR_VSX_REGISTRY", server.URL+"/api")
	t.Cleanup(func() { vsxClient = previous; server.Close() })
	return server.URL + "/api"
}

func TestVSXChecksumRequiredAndValidated(t *testing.T) {
	for _, checksum := range []string{"missing", "empty", "mismatch", "valid"} {
		t.Run(checksum, func(t *testing.T) {
			data := []byte("package bytes")
			base := vsxTestRegistry(t, func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, ".vsix") {
					w.Write(data)
					return
				}
				switch checksum {
				case "missing":
					http.NotFound(w, r)
				case "mismatch":
					fmt.Fprint(w, strings.Repeat("0", 64))
				case "valid":
					fmt.Fprintf(w, "%x  package.vsix\n", sha256.Sum256(data))
				}
			})
			got, sum, err := fetchVSIX(context.Background(), base+"/pub/ext/1/file/package.vsix")
			if checksum == "valid" {
				if err != nil || string(got) != string(data) || len(sum) != 64 {
					t.Fatal(string(got), sum, err)
				}
			} else if err == nil {
				t.Fatal("accepted unverifiable package", checksum)
			}
		})
	}
}

func TestVSXManifestRequestsShareAnInflightFetch(t *testing.T) {
	var count atomic.Int32
	base := vsxTestRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		fmt.Fprint(w, `{"name":"ext","contributes":{"languages":[{"id":"test"}]}}`)
	})
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m, err := vsxManifest(context.Background(), "pub", "ext", "1", base+"/pub/ext/1/file/package.vsix")
			if err != nil || str(m["name"]) != "ext" {
				t.Error(m, err)
			}
		}()
	}
	wg.Wait()
	if count.Load() != 1 {
		t.Fatal("duplicate manifest fetches", count.Load())
	}
}

func TestVSXDownloadNeverFallsBackToAForeignExecutable(t *testing.T) {
	platform, download := pickDownload(map[string]string{vsxPlatform(): "local", "universal": "portable"}, "fallback")
	if platform != vsxPlatform() || download != "local" {
		t.Fatal(platform, download)
	}
	platform, download = pickDownload(map[string]string{"foreign-platform": "wrong"}, "fallback")
	if platform != "" || download != "" {
		t.Fatal("foreign executable selected", platform, download)
	}
	platform, download = pickDownload(map[string]string{"universal": "portable"}, "")
	if platform != "universal" || download != "portable" {
		t.Fatal(platform, download)
	}
}
