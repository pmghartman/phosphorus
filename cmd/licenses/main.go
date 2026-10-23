// licenses: THIRD_PARTY_LICENSES.txt, every license text phosphorus ships
// or fetches, one copy per distinct text. Go modules of every OS's binary,
// the menu bar app's included, the web client's npm packages (go generate
// ./internal/web first) and the pinned tools. Run from the repo root: go run ./cmd/licenses
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type part struct {
	group, name, version, source string
	texts                        []string
	spdx                         string
}

var licenseFile = regexp.MustCompile(`(?i)^(licen[cs]e|copying|notice|unlicense)([-._].*)?$`)

func main() {
	out := flag.String("out", "THIRD_PARTY_LICENSES.txt", "where the texts land")
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("[licenses] ")
	parts := goParts()
	parts = append(parts, webParts()...)
	parts = append(parts, toolParts()...)
	must(os.WriteFile(*out, render(parts), 0o644))
	log.Printf("%d components into %s", len(parts), *out)
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func run(env []string, name string, args ...string) []byte {
	c := exec.Command(name, args...)
	c.Env = append(os.Environ(), env...)
	c.Stderr = os.Stderr
	b, err := c.Output()
	if err != nil {
		log.Fatalf("%s %s: %v", name, strings.Join(args, " "), err)
	}
	return b
}

// filesIn a directory's top-level license files, sorted
func filesIn(dir string) []string {
	ents, _ := os.ReadDir(dir)
	texts := []string{}
	for _, e := range ents {
		if e.Type().IsRegular() && licenseFile.MatchString(e.Name()) {
			b, err := os.ReadFile(filepath.Join(dir, e.Name()))
			must(err)
			texts = append(texts, string(b))
		}
	}
	return texts
}

// --- go -----------------------------------------------------------------------

func goParts() []part {
	seen := map[string]part{}
	for _, t := range [][2]string{{"linux", "amd64"}, {"linux", "arm64"}, {"darwin", "arm64"}, {"darwin", "amd64"}, {"windows", "amd64"}} {
		b := run([]string{"GOOS=" + t[0], "GOARCH=" + t[1], "CGO_ENABLED=0"}, "go", "list", "-deps",
			"-f", "{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}", "./cmd/phosphorus", "./cmd/tray", "./cmd/sulfur")
		for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
			f := strings.Split(l, "\t")
			if len(f) != 3 || seen[f[0]].name != "" {
				continue
			}
			texts := filesIn(f[2])
			if len(texts) == 0 {
				log.Fatalf("go module %s has no license file in %s", f[0], f[2])
			}
			seen[f[0]] = part{group: "Go modules in the phosphorus binary", name: f[0], version: f[1], source: "https://pkg.go.dev/" + f[0], texts: texts}
		}
	}
	root := strings.TrimSpace(string(run(nil, "go", "env", "GOROOT")))
	// go.mod's version, not the installed toolchain's, so any machine and ci write the same file
	ver := "go" + strings.TrimSpace(string(run(nil, "go", "list", "-m", "-f", "{{.GoVersion}}")))
	parts := []part{{group: "Go modules in the phosphorus binary", name: "Go standard library and runtime", version: ver, source: "https://go.dev", texts: filesIn(root)}}
	for _, p := range seen {
		parts = append(parts, p)
	}
	return parts
}

// --- web ----------------------------------------------------------------------

func webParts() []part {
	b, err := os.ReadFile("web/vendor.lock")
	must(err)
	var lock map[string]struct{ Version string }
	must(json.Unmarshal(b, &lock))
	parts := []part{}
	for name, p := range lock {
		dir := filepath.Join("web/.vendor/node_modules", name)
		texts := filesIn(dir)
		if len(texts) == 0 {
			log.Fatalf("npm %s has no license file in %s, run go generate ./internal/web first", name, dir)
		}
		parts = append(parts, part{group: "npm packages in the web client", name: name, version: p.Version, source: "https://www.npmjs.com/package/" + name, texts: texts})
	}
	return parts
}

// --- tools --------------------------------------------------------------------

func pinned(file, re string) string {
	b, err := os.ReadFile(file)
	must(err)
	m := regexp.MustCompile(re).FindSubmatch(b)
	if m == nil {
		log.Fatalf("no version in %s", file)
	}
	return string(m[1])
}

func fetch(url string) string {
	c := &http.Client{Timeout: 60 * time.Second}
	for i := 0; ; i++ {
		res, err := c.Get(url)
		if err == nil && res.StatusCode == 200 {
			b, err := io.ReadAll(res.Body)
			res.Body.Close()
			must(err)
			return string(b)
		}
		if err == nil {
			res.Body.Close()
			err = fmt.Errorf("%s", res.Status)
		}
		if i == 3 {
			log.Fatalf("%s: %v", url, err)
		}
		time.Sleep(time.Duration(2<<i) * time.Second)
	}
}

func toolParts() []part {
	ts := pinned("packaging/tools.sh", `(?m)^TAILSCALE=(\S+)`)
	cf := pinned("packaging/tools.sh", `(?m)^CLOUDFLARED=(\S+)`)
	fj := pinned("packaging/tools.sh", `(?m)^FORGEJO=(\S+)`)
	ll := pinned("internal/tools/tools.go", `LlamaTag\s*=\s*"([^"]+)"`)
	bundled, fetched := "Programs bundled with the host installers", "Programs a model host downloads at run time"
	return []part{
		{group: bundled, name: "Tailscale", version: ts, source: "https://github.com/tailscale/tailscale",
			texts: []string{fetch("https://raw.githubusercontent.com/tailscale/tailscale/v" + ts + "/LICENSE")}},
		{group: bundled, name: "cloudflared", version: cf, source: "https://github.com/cloudflare/cloudflared",
			texts: []string{fetch("https://raw.githubusercontent.com/cloudflare/cloudflared/" + cf + "/LICENSE")}},
		{group: bundled, name: "Forgejo", version: fj, source: "https://codeberg.org/forgejo/forgejo/src/tag/v" + fj,
			texts: []string{fetch("https://codeberg.org/forgejo/forgejo/raw/tag/v" + fj + "/LICENSE")}},
		{group: fetched, name: "llama.cpp", version: ll, source: "https://github.com/ggml-org/llama.cpp",
			texts: []string{fetch("https://raw.githubusercontent.com/ggml-org/llama.cpp/" + ll + "/LICENSE")}},
	}
}

// spdxTag the SPDX license list release the appendix's texts come from
const spdxTag = "v3.27.0"

// chosen the license taken from an SPDX expression: MIT when offered, else the first
func chosen(expr string) string {
	// the old "MIT/Apache-2.0" form an OR too
	opts := strings.Split(strings.ReplaceAll(expr, "/", " OR "), " OR ")
	for _, o := range opts {
		if strings.TrimSpace(o) == "MIT" {
			return "MIT"
		}
	}
	return strings.Trim(strings.TrimSpace(opts[0]), "()")
}

// --- output -------------------------------------------------------------------

func norm(s string) string {
	return strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
}

// render each component under its group, then each distinct text once with
// every component it covers
func render(parts []part) []byte {
	groups := []string{"Go modules in the phosphorus binary", "npm packages in the web client",
		"Programs bundled with the host installers", "Programs a model host downloads at run time"}
	sort.Slice(parts, func(i, j int) bool {
		if parts[i].group != parts[j].group {
			return parts[i].group < parts[j].group
		}
		if parts[i].name != parts[j].name {
			return parts[i].name < parts[j].name
		}
		return parts[i].version < parts[j].version
	})
	type text struct {
		id    int
		body  string
		users []string
	}
	byHash := map[[32]byte]*text{}
	order := []*text{}
	for _, p := range parts {
		for _, t := range p.texts {
			body := norm(t)
			h := sha256.Sum256([]byte(body))
			x := byHash[h]
			if x == nil {
				x = &text{body: body}
				byHash[h] = x
				order = append(order, x)
			}
			x.users = append(x.users, p.name+" "+p.version)
		}
	}
	sort.SliceStable(order, func(i, j int) bool { return order[i].users[0] < order[j].users[0] })
	for i, x := range order {
		x.id = i + 1
	}
	var b bytes.Buffer
	fj := pinned("packaging/tools.sh", `(?m)^FORGEJO=(\S+)`)
	b.WriteString("Third-party licenses\n\nGenerated by go run ./cmd/licenses. Each component below stays under its own\nlicense; the phosphorus license (LICENSE) covers none of them. Components are\nlisted by group, then every distinct license text follows once, with the\ncomponents it covers.\n\n" +
		"Forgejo runs as a separate, unmodified program; phosphorus only writes its\nconfiguration. Its complete corresponding source, forgejo-src-" + fj + ".tar.gz, is at:\nhttps://codeberg.org/forgejo/forgejo/releases/download/v" + fj + "/forgejo-src-" + fj + ".tar.gz\n\n" +
		"With [model] gpu on an nvidia gpu, the model host also downloads NVIDIA's CUDA\nruntime from llama.cpp's releases, under the NVIDIA CUDA EULA\n(https://docs.nvidia.com/cuda/eula/). phosphorus ships no model; a model's\nweights come under its own license.\n\n" +
		"Cloudflare, Forgejo and Tailscale are trademarks of their respective owners;\nphosphorus is not affiliated with or endorsed by any of them.\n")
	for _, g := range groups {
		b.WriteString("\n\n== " + g + " ==\n\n")
		for _, p := range parts {
			if p.group != g {
				continue
			}
			ids := []string{}
			for _, t := range p.texts {
				ids = append(ids, fmt.Sprintf("[%d]", byHash[sha256.Sum256([]byte(norm(t)))].id))
			}
			line := p.name + " " + p.version
			if p.spdx != "" {
				line += ", " + p.spdx
			}
			if len(ids) > 0 {
				line += ", text " + strings.Join(ids, " ")
			} else {
				line += ", standard " + chosen(p.spdx) + " text in the appendix"
			}
			b.WriteString(line + "\n    " + p.source + "\n")
		}
	}
	b.WriteString("\n\n== License texts ==\n")
	for _, x := range order {
		fmt.Fprintf(&b, "\n\n---- [%d] %s ----\n\n%s\n", x.id, strings.Join(x.users, ", "), x.body)
	}
	appendix := map[string][]string{}
	for _, p := range parts {
		if len(p.texts) == 0 {
			l := chosen(p.spdx)
			appendix[l] = append(appendix[l], p.name+" "+p.version)
		}
	}
	if len(appendix) > 0 {
		b.WriteString("\n\n== Appendix: standard texts for crates that ship none ==\n")
		ls := make([]string, 0, len(appendix))
		for l := range appendix {
			ls = append(ls, l)
		}
		sort.Strings(ls)
		for _, l := range ls {
			fmt.Fprintf(&b, "\n\n---- %s: %s ----\n\n%s\n", l, strings.Join(appendix[l], ", "),
				norm(fetch("https://raw.githubusercontent.com/spdx/license-list-data/"+spdxTag+"/text/"+l+".txt")))
		}
	}
	return b.Bytes()
}
