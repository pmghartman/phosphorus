// webbuild: web/ into internal/web/dist, run by go generate. Pinned npm
// tarballs fetched over HTTP and checked against vendor.lock (patches.go put in), the client
// bundled by esbuild, every text file precompressed. No node.
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/evanw/esbuild/pkg/api"

	"github.com/pmghartman/phosphorus/internal/theme"
)

type pkg struct {
	Version   string `json:"version"`
	Resolved  string `json:"resolved"`
	Integrity string `json:"integrity"`
}

func main() {
	src := flag.String("src", "web", "the client's source")
	out := flag.String("out", "internal/web/dist", "where the build lands")
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("[webbuild] ")

	vendor := filepath.Join(*src, ".vendor")
	modules := filepath.Join(vendor, "node_modules")
	var lock map[string]pkg
	b, err := os.ReadFile(filepath.Join(*src, "vendor.lock"))
	must(err)
	must(json.Unmarshal(b, &lock))
	names := make([]string, 0, len(lock))
	for n := range lock {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		must(fetch(n, lock[n], vendor, modules))
	}

	must(os.RemoveAll(*out))
	must(os.MkdirAll(filepath.Join(*out, "vendor"), 0o755))
	os.WriteFile(filepath.Join(*out, "README"), []byte("built by go generate ./internal/web\n"), 0o644)

	// vendor files outside the bundle: fonts as they are, the rest hashed
	assets := map[string]string{}
	hashed := func(from, name string) string {
		data, err := os.ReadFile(from)
		must(err)
		h := sha256.Sum256(data)
		ext := filepath.Ext(name)
		rel := "vendor/h/" + strings.TrimSuffix(name, ext) + "-" + hex.EncodeToString(h[:6]) + ext
		must(os.MkdirAll(filepath.Dir(filepath.Join(*out, rel)), 0o755))
		must(os.WriteFile(filepath.Join(*out, rel), data, 0o644))
		return "/" + rel
	}
	assets["xterm.css"] = hashed(filepath.Join(modules, "@xterm/xterm/css/xterm.css"), "xterm.css")
	// katex's css beside its fonts, the folder named by the css's hash
	kcss, err := os.ReadFile(filepath.Join(modules, "katex/dist/katex.min.css"))
	must(err)
	kh := sha256.Sum256(kcss)
	kdir := "vendor/h/katex-" + hex.EncodeToString(kh[:6])
	must(copyDir(filepath.Join(modules, "katex/dist/fonts"), filepath.Join(*out, kdir, "fonts"), ".woff2"))
	must(os.WriteFile(filepath.Join(*out, kdir, "katex.css"), kcss, 0o644))
	assets["katex.css"] = "/" + kdir + "/katex.css"
	define, _ := json.Marshal(assets)
	// the theme library's tokens as CSS, the first thing style.css imports
	themes := api.Plugin{Name: "phosphorus-themes", Setup: func(b api.PluginBuild) {
		b.OnResolve(api.OnResolveOptions{Filter: `^phosphorus:themes$`}, func(api.OnResolveArgs) (api.OnResolveResult, error) {
			return api.OnResolveResult{Path: "themes.css", Namespace: "phosphorus-themes"}, nil
		})
		b.OnLoad(api.OnLoadOptions{Filter: `.*`, Namespace: "phosphorus-themes"}, func(api.OnLoadArgs) (api.OnLoadResult, error) {
			css := theme.Load().CSS()
			return api.OnLoadResult{Contents: &css, Loader: api.LoaderCSS}, nil
		})
	}}
	opts := func(entry, outdir string) api.BuildOptions {
		return api.BuildOptions{
			EntryPoints:       []string{filepath.Join(*src, entry), filepath.Join(*src, "style.css")},
			Bundle:            true,
			Format:            api.FormatESModule,
			Outdir:            filepath.Join(*out, outdir),
			EntryNames:        "[name]-[hash]",
			AssetNames:        "[name]-[hash]",
			MinifyWhitespace:  true,
			MinifyIdentifiers: true,
			MinifySyntax:      true,
			Target:            api.ES2020,
			NodePaths:         []string{modules},
			External:          []string{"/vendor/*"},
			Define:            map[string]string{"__ASSETS__": string(define)},
			Loader:            map[string]api.Loader{".md": api.LoaderText},
			Metafile:          true,
			Write:             true,
			LegalComments:     api.LegalCommentsLinked,
			Charset:           api.CharsetUTF8,
			LogLevel:          api.LogLevelWarning,
			Plugins:           []api.Plugin{themes},
		}
	}
	page(*out, filepath.Join(*src, "index.html"), "index.html", "/src/main.js", api.Build(opts("src/main.js", "assets")))
	must(copyDir(filepath.Join(*src, "static"), *out, ""))

	n := 0
	must(filepath.Walk(*out, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !compressible.MatchString(p) {
			return err
		}
		n++
		return precompress(p, hashedPath(*out, p))
	}))
	log.Printf("built the desktop's page, %d files precompressed", n)
}

// page a build's html: its entry and style put in
func page(out, from, to, script string, res api.BuildResult) {
	if len(res.Errors) > 0 {
		for _, e := range res.Errors {
			log.Printf("%s", e.Text)
			if e.Location != nil {
				log.Printf("  %s:%d: %s", e.Location.File, e.Location.Line, e.Location.LineText)
			}
		}
		os.Exit(1)
	}
	var meta struct {
		Outputs map[string]struct {
			EntryPoint string `json:"entryPoint"`
		} `json:"outputs"`
	}
	must(json.Unmarshal([]byte(res.Metafile), &meta))
	entry := map[string]string{}
	for outFile, o := range meta.Outputs {
		if o.EntryPoint != "" {
			rel, _ := filepath.Rel(out, outFile)
			entry[filepath.Base(o.EntryPoint)] = "/" + filepath.ToSlash(rel)
		}
	}
	html, err := os.ReadFile(from)
	must(err)
	p := strings.Replace(string(html), `href="/style.css"`, `href="`+entry["style.css"]+`"`, 1)
	p = strings.Replace(p, `<script type="module" src="`+script+`"></script>`, `<script type="module" src="`+entry["main.js"]+`"></script>`, 1)
	if !strings.Contains(p, entry["main.js"]) || !strings.Contains(p, entry["style.css"]) {
		log.Fatalf("%s lost its style.css or main.js tag", filepath.Base(from))
	}
	must(os.MkdirAll(filepath.Dir(filepath.Join(out, to)), 0o755))
	must(os.WriteFile(filepath.Join(out, to), []byte(p), 0o644))
}

var compressible = regexp.MustCompile(`\.(js|css|html|svg|json|txt|map)$`)

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func fetch(name string, p pkg, vendor, modules string) error {
	dir := filepath.Join(modules, name)
	stamp := filepath.Join(dir, ".integrity")
	want := patchStamp(name, p.Integrity)
	if b, err := os.ReadFile(stamp); err == nil && string(b) == want {
		return nil
	}
	cache := filepath.Join(vendor, "cache", strings.ReplaceAll(name, "/", "_")+"-"+p.Version+".tgz")
	data, err := os.ReadFile(cache)
	if err != nil || verify(data, p.Integrity) != nil {
		log.Printf("fetching %s@%s", name, p.Version)
		res, err := http.Get(p.Resolved)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return fmt.Errorf("%s: %s", p.Resolved, res.Status)
		}
		if data, err = io.ReadAll(res.Body); err != nil {
			return err
		}
		if err := verify(data, p.Integrity); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		os.MkdirAll(filepath.Dir(cache), 0o755)
		if err := os.WriteFile(cache, data, 0o644); err != nil {
			return err
		}
	}
	os.RemoveAll(dir)
	if err := untar(data, dir); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	if err := applyPatches(name, dir); err != nil {
		return err
	}
	return os.WriteFile(stamp, []byte(want), 0o644)
}

func verify(data []byte, integrity string) error {
	want, ok := strings.CutPrefix(integrity, "sha512-")
	if !ok {
		return fmt.Errorf("integrity %q isn't sha512", integrity)
	}
	sum := sha512.Sum512(data)
	if base64.StdEncoding.EncodeToString(sum[:]) != want {
		return fmt.Errorf("checksum mismatch")
	}
	return nil
}

// untar an npm tarball's package/ into dir, nothing written outside it
func untar(data []byte, dir string) error {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		parts := strings.SplitN(filepath.ToSlash(h.Name), "/", 2)
		if len(parts) < 2 {
			continue
		}
		rel := filepath.Clean(parts[1])
		if strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			return fmt.Errorf("bad path %s", h.Name)
		}
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		f, err := os.Create(p)
		if err != nil {
			return err
		}
		_, err = io.Copy(f, tr)
		f.Close()
		if err != nil {
			return err
		}
	}
}

func copyDir(from, to, ext string) error {
	return filepath.Walk(from, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || (ext != "" && filepath.Ext(p) != ext) {
			return err
		}
		rel, _ := filepath.Rel(from, p)
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		dst := filepath.Join(to, rel)
		os.MkdirAll(filepath.Dir(dst), 0o755)
		return os.WriteFile(dst, data, 0o644)
	})
}

// hashedPath under assets/ or vendor/h/, the server's cached-for-good files
func hashedPath(out, p string) bool {
	rel, _ := filepath.Rel(out, p)
	rel = filepath.ToSlash(rel)
	return strings.HasPrefix(rel, "assets/") || strings.HasPrefix(rel, "vendor/h/")
}

// precompress p as .gz, a hashed file's own copy then dropped
func precompress(p string, dropRaw bool) error {
	data, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	var gz bytes.Buffer
	g, _ := gzip.NewWriterLevel(&gz, gzip.BestCompression)
	g.Write(data)
	g.Close()
	if gz.Len() >= len(data) {
		return nil
	}
	if err := os.WriteFile(p+".gz", gz.Bytes(), 0o644); err != nil {
		return err
	}
	if dropRaw {
		return os.Remove(p)
	}
	return nil
}
