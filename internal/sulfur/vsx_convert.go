package sulfur

// VS Code extensions made Sulfur's: a .vsix (a zip whose extension/package.json
// is the manifest) read for what it declares, and written out as an extension
// Sulfur loads from ~/.sulfur/extensions. Declarative features use native editor
// machinery; compatible browser builds use an isolated API bridge (vsx_web.go).
//
// What maps: color themes (workbench colors onto --ide-*, token colors onto the
// --hl-* syntax tokens), file icon themes (svg/png icons and icon fonts, inlined),
// languages and their configurations (comments, brackets), TextMate grammars
// (json or plist), snippets, keybindings to commands Sulfur has, and a language
// server the package carries (a node module or a native binary), installed on a
// host by the language host. Browser commands, webviews, custom editors and
// sidebar providers use the compatibility host. Node-only code, debuggers and
// unsupported contribution points are reported rather than silently dropped.

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// VSXReportItem one line of a conversion's report
type VSXReportItem struct {
	// theme, iconTheme, language, grammar, snippets, keybindings, languageServer,
	// settings, commands, code or the contribution point's own name
	Kind string `json:"kind"`
	// converted, partial or skipped
	Status string `json:"status"`
	Name   string `json:"name"`
	Detail string `json:"detail,omitempty"`
}

// VSXSource where a package came from, kept in the converted manifest
type VSXSource struct {
	Registry       string `json:"registry"`
	Namespace      string `json:"namespace"`
	Name           string `json:"name"`
	Version        string `json:"version"`
	TargetPlatform string `json:"targetPlatform,omitempty"`
	Download       string `json:"download,omitempty"`
	SHA256         string `json:"sha256,omitempty"`
}

// VSXConversion the Sulfur extension made from a package: its folder's name, its text
// files, its binary ones (a web build's wasm and images, base64) and the report
type VSXConversion struct {
	ID       string            `json:"id"`
	Manifest map[string]any    `json:"manifest"`
	Files    map[string]string `json:"files"`
	Binary   map[string]string `json:"binary,omitempty"`
	Report   []VSXReportItem   `json:"report"`
}

// VSXOptions what the page knows: Sulfur's command ids, for keybindings
type VSXOptions struct {
	Commands map[string]bool
}

const (
	vsxConverted = "converted"
	vsxPartial   = "partial"
	vsxSkipped   = "skipped"
	// the largest file read out of a package, and the most a converted extension holds
	vsxFileMax  = 32 << 20
	vsxTotalMax = 14 << 20
)

// the contribution points nothing in Sulfur can stand in for, and why
var vsxUnsupported = map[string]string{
	"commands":                     "commands run the extension's code",
	"menus":                        "menus run the extension's commands",
	"submenus":                     "menus run the extension's commands",
	"views":                        "views are drawn by the extension's code",
	"viewsContainers":              "views are drawn by the extension's code",
	"viewsWelcome":                 "views are drawn by the extension's code",
	"customEditors":                "custom editors are webviews the extension's code draws",
	"webviews":                     "webviews are the extension's code",
	"debuggers":                    "Sulfur has no debug adapter host",
	"breakpoints":                  "Sulfur has no debug adapter host",
	"taskDefinitions":              "tasks are provided by the extension's code; Sulfur's tasks live in .sulfur/build.json",
	"problemMatchers":              "Sulfur reads build problems itself",
	"problemPatterns":              "Sulfur reads build problems itself",
	"jsonValidation":               "JSON schemas need a JSON language server",
	"walkthroughs":                 "walkthroughs are VS Code's getting-started pages",
	"notebooks":                    "Sulfur has no notebooks",
	"notebookRenderer":             "Sulfur has no notebooks",
	"terminal":                     "terminal profiles are the extension's code",
	"authentication":               "authentication providers are the extension's code",
	"colors":                       "theme colors for the extension's own UI",
	"semanticTokenTypes":           "semantic token types come from language servers Sulfur colors itself",
	"semanticTokenModifiers":       "semantic token types come from language servers Sulfur colors itself",
	"semanticTokenScopes":          "semantic token types come from language servers Sulfur colors itself",
	"icons":                        "product icons: Sulfur draws its own",
	"productIconThemes":            "product icons: Sulfur draws its own",
	"localizations":                "display language packs translate VS Code's own UI",
	"resourceLabelFormatters":      "remote file systems are the extension's code",
	"typescriptServerPlugins":      "plugins for VS Code's built-in TypeScript service",
	"html":                         "custom data for VS Code's built-in HTML service",
	"css":                          "custom data for VS Code's built-in CSS service",
	"codeActions":                  "code actions come from the extension's code",
	"documentation":                "documentation for the extension's code actions",
	"chatParticipants":             "chat participants are the extension's code",
	"languageModelTools":           "language model tools are the extension's code",
	"mcpServerDefinitionProviders": "MCP servers are started by the extension's code",
	"continueEditSession":          "VS Code's edit sessions",
	"remoteHelp":                   "VS Code's remote development",
	"statusBarItems":               "status bar items run the extension's commands",
}

// the extensions Sulfur parses itself (host.js CODE_EXT's with a Lezer grammar): a
// TextMate grammar for one of them stays unused, the parser being better
var sulfurParsed = map[string]bool{
	"js": true, "mjs": true, "cjs": true, "jsx": true, "ts": true, "mts": true, "tsx": true, "py": true,
	"c": true, "h": true, "cpp": true, "cc": true, "cxx": true, "hpp": true, "go": true, "rs": true,
	"java": true, "php": true, "css": true, "html": true, "htm": true, "xml": true, "svg": true,
	"json": true, "yml": true, "yaml": true, "csproj": true,
}

// VS Code's built-in language ids, their extensions and file names: what a
// package's languages, snippets, icons and servers say by id
var vscodeLanguages = map[string][2]string{
	"bat":              {"bat cmd", ""},
	"c":                {"c i", ""},
	"clojure":          {"clj cljs cljc cljx clojure edn", ""},
	"coffeescript":     {"coffee cson iced", ""},
	"cpp":              {"cpp cppm cc ccm cxx cxxm c++ hpp hh hxx h++ h ii ino inl ipp ixx tpp txx", ""},
	"csharp":           {"cs csx cake", ""},
	"css":              {"css", ""},
	"cuda-cpp":         {"cu cuh", ""},
	"dart":             {"dart", ""},
	"diff":             {"diff patch rej", ""},
	"dockerfile":       {"dockerfile containerfile", "dockerfile containerfile"},
	"elixir":           {"ex exs", ""},
	"erlang":           {"erl hrl", ""},
	"fsharp":           {"fs fsi fsx fsscript", ""},
	"go":               {"go", ""},
	"graphql":          {"graphql gql", ""},
	"groovy":           {"groovy gvy gradle jenkinsfile nf", "jenkinsfile"},
	"handlebars":       {"handlebars hbs hjs", ""},
	"haskell":          {"hs lhs", ""},
	"hlsl":             {"hlsl hlsli fx fxh vsh psh cginc compute", ""},
	"html":             {"html htm shtml xhtml xht mdoc jsp asp aspx jshtm volt ejs rhtml", ""},
	"ini":              {"ini", ""},
	"java":             {"java jav", ""},
	"javascript":       {"js es6 mjs cjs pac", "jakefile"},
	"javascriptreact":  {"jsx", ""},
	"json":             {"json bowerrc jscsrc webmanifest js.map css.map ts.map har jslintrc jsonld geojson ipynb vuerc", "composer.lock .watchmanconfig"},
	"jsonc":            {"jsonc eslintrc eslintrc.json jsfmtrc jshintrc swcrc hintrc babelrc code-workspace", "tsconfig.json jsconfig.json .devcontainer.json devcontainer.json"},
	"julia":            {"jl", ""},
	"kotlin":           {"kt kts", ""},
	"latex":            {"tex ltx ctx", ""},
	"bibtex":           {"bib", ""},
	"less":             {"less", ""},
	"lua":              {"lua", ""},
	"makefile":         {"mak mk", "makefile gnumakefile ocamlmakefile"},
	"markdown":         {"md mkd mdwn mdown markdown markdn mdtxt mdtext workbook", ""},
	"nim":              {"nim nims nimble", ""},
	"nix":              {"nix", ""},
	"objective-c":      {"m", ""},
	"objective-cpp":    {"mm", ""},
	"ocaml":            {"ml mli", ""},
	"perl":             {"pl pm pod t psgi", ""},
	"php":              {"php php4 php5 phtml ctp", ""},
	"plaintext":        {"txt", ""},
	"powershell":       {"ps1 psm1 psd1 pssc psrc", ""},
	"prisma":           {"prisma", ""},
	"properties":       {"properties cfg conf directory gitattributes gitconfig gitmodules editorconfig repo", ""},
	"proto":            {"proto", ""},
	"python":           {"py rpy pyw cpy gyp gypi pyi ipy pyt", "snakefile sconstruct sconscript"},
	"r":                {"r rhistory rprofile rt", ""},
	"razor":            {"cshtml razor", ""},
	"restructuredtext": {"rst", ""},
	"ruby":             {"rb rbx rjs gemspec rake ru erb podspec rbi", "rakefile gemfile guardfile podfile capfile cheffile hobofile vagrantfile appraisals rantfile berksfile berksfile.lock thorfile puppetfile dangerfile brewfile fastfile appfile deliverfile matchfile scanfile snapfile gymfile"},
	"rust":             {"rs", ""},
	"scala":            {"scala sc sbt", ""},
	"scss":             {"scss", ""},
	"shaderlab":        {"shader", ""},
	"shellscript":      {"sh bash bashrc bash_aliases bash_profile bash_login ebuild profile bash_logout xprofile xsession xsessionrc zsh zshrc zprofile zlogin zlogout zshenv zsh-theme fish ksh csh cshrc tcshrc yashrc yash_profile", "apkbuild pkgbuild .envrc .hushlogin zshrc zshenv zlogin zprofile zlogout bashrc_apple_terminal zshrc_apple_terminal"},
	"sql":              {"sql dsql", ""},
	"svelte":           {"svelte", ""},
	"swift":            {"swift", ""},
	"terraform":        {"tf tfvars", ""},
	"toml":             {"toml", "cargo.lock pipfile poetry.lock uv.lock"},
	"typescript":       {"ts cts mts", ""},
	"typescriptreact":  {"tsx", ""},
	"vb":               {"vb brs vbs bas vba", ""},
	"vue":              {"vue", ""},
	"xml":              {"xml xsd ascx atom axml axaml bpmn cpt csl csproj dita ditamap dtd ent mod dtml fsproj fxml iml isml jmx launch menu mxml nuspec opml owl proj props pt publishsettings pubxml pubxml.user rbxlx rbxmx rdf rng rss shproj storyboard svg targets tld tmx vbproj vcxproj vcxproj.filters wsdl wxi wxl wxs xaml xbl xib xlf xliff xpdl xul xoml", ""},
	"xsl":              {"xsl xslt", ""},
	"yaml":             {"yaml yml eyaml eyml cff", ""},
	"zig":              {"zig zon", ""},
}

// --- reading a package ------------------------------------------------------------

// vsixPackage a package's files under extension/, read on demand
type vsixPackage struct {
	files map[string]*zip.File
	nls   map[string]any
}

func openVSIX(data []byte) (*vsixPackage, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New("not a .vsix: " + err.Error())
	}
	p := &vsixPackage{files: map[string]*zip.File{}}
	names := map[string]bool{}
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if !strings.HasPrefix(name, "extension/") || strings.HasSuffix(name, "/") {
			continue
		}
		rel := cleanRel("", strings.TrimPrefix(name, "extension/"))
		if rel == "" || strings.ContainsAny(rel, ":\x00") {
			return nil, fmt.Errorf("unsafe package path: %s", name)
		}
		if names[strings.ToLower(rel)] {
			return nil, fmt.Errorf("duplicate package path: %s", name)
		}
		names[strings.ToLower(rel)] = true
		p.files[rel] = f
	}
	if p.files["package.json"] == nil {
		return nil, errors.New("not a .vsix: no extension/package.json")
	}
	if b, err := p.read("package.nls.json"); err == nil {
		json.Unmarshal(stripJSONC(b), &p.nls)
	}
	return p, nil
}

// cleanRel a manifest's path as a key of the package's files, "" for one that leaves it
func cleanRel(base, rel string) string {
	rel = strings.ReplaceAll(rel, "\\", "/")
	if strings.HasPrefix(rel, "/") {
		return ""
	}
	p := path.Clean(path.Join(base, rel))
	if p == "." || p == ".." || strings.HasPrefix(p, "../") {
		return ""
	}
	return p
}

func (p *vsixPackage) read(rel string) ([]byte, error) {
	f := p.files[rel]
	if f == nil {
		// zips from Windows tools keep the case they were packed with
		for k, v := range p.files {
			if strings.EqualFold(k, rel) {
				f = v
				break
			}
		}
	}
	if f == nil {
		return nil, fmt.Errorf("%s isn't in the package", rel)
	}
	if f.UncompressedSize64 > vsxFileMax {
		return nil, fmt.Errorf("%s is over %dMB", rel, vsxFileMax>>20)
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(io.LimitReader(rc, vsxFileMax))
}

// readData a json, jsonc or plist file as plain data
func (p *vsixPackage) readData(rel string) (any, error) {
	b, err := p.read(rel)
	if err != nil {
		return nil, err
	}
	return parseData(rel, b)
}

func parseData(rel string, b []byte) (any, error) {
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	low := strings.ToLower(rel)
	switch {
	case strings.HasSuffix(low, ".yaml") || strings.HasSuffix(low, ".yml"):
		return nil, errors.New("YAML sources aren't read; the package has to ship JSON or plist")
	case bytes.HasPrefix(bytes.TrimSpace(b), []byte("<")):
		return parsePlist(b)
	}
	var v any
	if err := json.Unmarshal(stripJSONC(b), &v); err != nil {
		return nil, fmt.Errorf("%s: %v", rel, err)
	}
	return v, nil
}

// localize a manifest string: "%key%" from package.nls.json
func (p *vsixPackage) localize(v any) string {
	s, _ := v.(string)
	if len(s) > 2 && s[0] == '%' && s[len(s)-1] == '%' {
		switch t := p.nls[s[1:len(s)-1]].(type) {
		case string:
			return t
		case map[string]any:
			if m, ok := t["message"].(string); ok {
				return m
			}
		}
	}
	return s
}

// stripJSONC JSON with comments and trailing commas made JSON, strings untouched
func stripJSONC(b []byte) []byte {
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); i++ {
		c := b[i]
		switch {
		case c == '"':
			j := i + 1
			for j < len(b) && b[j] != '"' {
				if b[j] == '\\' {
					j++
				}
				j++
			}
			if j >= len(b) {
				j = len(b) - 1
			}
			out = append(out, b[i:j+1]...)
			i = j
		case c == '/' && i+1 < len(b) && b[i+1] == '/':
			for i < len(b) && b[i] != '\n' {
				i++
			}
			if i < len(b) {
				out = append(out, '\n')
			}
		case c == '/' && i+1 < len(b) && b[i+1] == '*':
			end := bytes.Index(b[i+2:], []byte("*/"))
			if end < 0 {
				return out
			}
			i += end + 3
		case c == ',':
			// a trailing comma: the next thing that isn't space or a comment closes
			j := i + 1
			for j < len(b) {
				if b[j] == ' ' || b[j] == '\t' || b[j] == '\r' || b[j] == '\n' {
					j++
				} else if b[j] == '/' && j+1 < len(b) && b[j+1] == '/' {
					for j < len(b) && b[j] != '\n' {
						j++
					}
				} else if b[j] == '/' && j+1 < len(b) && b[j+1] == '*' {
					end := bytes.Index(b[j+2:], []byte("*/"))
					if end < 0 {
						j = len(b)
					} else {
						j += end + 4
					}
				} else {
					break
				}
			}
			if j < len(b) && (b[j] == '}' || b[j] == ']') {
				continue
			}
			out = append(out, c)
		default:
			out = append(out, c)
		}
	}
	return out
}

// parsePlist an Apple property list (.tmLanguage, .tmTheme) as plain data
func parsePlist(b []byte) (any, error) {
	d := xml.NewDecoder(bytes.NewReader(b))
	d.Strict = false
	d.Entity = xml.HTMLEntity
	var value func(start xml.StartElement) (any, error)
	text := func() (string, error) {
		var sb strings.Builder
		for {
			t, err := d.Token()
			if err != nil {
				return "", err
			}
			switch x := t.(type) {
			case xml.CharData:
				sb.Write(x)
			case xml.EndElement:
				return sb.String(), nil
			case xml.StartElement:
				d.Skip()
			}
		}
	}
	next := func() (*xml.StartElement, bool, error) {
		for {
			t, err := d.Token()
			if err != nil {
				return nil, false, err
			}
			switch x := t.(type) {
			case xml.StartElement:
				return &x, false, nil
			case xml.EndElement:
				return nil, true, nil
			}
		}
	}
	value = func(start xml.StartElement) (any, error) {
		switch start.Name.Local {
		case "dict":
			m := map[string]any{}
			for {
				k, end, err := next()
				if err != nil {
					return nil, err
				}
				if end {
					return m, nil
				}
				if k.Name.Local != "key" {
					d.Skip()
					continue
				}
				key, err := text()
				if err != nil {
					return nil, err
				}
				v, end, err := next()
				if err != nil {
					return nil, err
				}
				if end {
					return m, nil
				}
				if m[key], err = value(*v); err != nil {
					return nil, err
				}
			}
		case "array":
			a := []any{}
			for {
				v, end, err := next()
				if err != nil {
					return nil, err
				}
				if end {
					return a, nil
				}
				x, err := value(*v)
				if err != nil {
					return nil, err
				}
				a = append(a, x)
			}
		case "string", "data", "date":
			return text()
		case "integer", "real":
			s, err := text()
			if err != nil {
				return nil, err
			}
			f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
			return f, nil
		case "true", "false":
			d.Skip()
			return start.Name.Local == "true", nil
		}
		d.Skip()
		return nil, nil
	}
	for {
		t, err := d.Token()
		if err != nil {
			return nil, errors.New("plist: " + err.Error())
		}
		if s, ok := t.(xml.StartElement); ok && s.Name.Local != "plist" {
			return value(s)
		}
	}
}

// --- the plan: what a manifest would become, before its package is fetched ---------

func asList(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	if v != nil {
		return []any{v}
	}
	return nil
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// usesLanguageClient whether the manifest says it starts a language server
func usesLanguageClient(m map[string]any) bool {
	for _, k := range []string{"dependencies", "devDependencies"} {
		for dep := range asMap(m[k]) {
			if dep == "vscode-languageclient" || strings.HasSuffix(dep, "language-server") || strings.HasSuffix(dep, "languageserver") {
				return true
			}
		}
	}
	return false
}

// VSXPlan what a manifest would convert to, from package.json alone: the library
// shows it before anything's downloaded
func VSXPlan(m map[string]any) []VSXReportItem {
	c := asMap(m["contributes"])
	out := []VSXReportItem{}
	add := func(kind, status, name, detail string) {
		out = append(out, VSXReportItem{Kind: kind, Status: status, Name: name, Detail: detail})
	}
	count := func(k string) int { return len(asList(c[k])) }
	if n := count("themes"); n > 0 {
		add("theme", vsxConverted, plural(n, "color theme"), "")
	}
	if n := count("iconThemes"); n > 0 {
		add("iconTheme", vsxConverted, plural(n, "file icon theme"), "")
	}
	if n := count("languages"); n > 0 {
		add("language", vsxConverted, plural(n, "language"), "")
	}
	if n := count("grammars"); n > 0 {
		add("grammar", vsxConverted, plural(n, "grammar"), "")
	}
	if n := count("snippets"); n > 0 {
		add("snippets", vsxConverted, plural(n, "snippet file"), "")
	}
	if n := count("keybindings"); n > 0 {
		add("keybindings", vsxPartial, plural(n, "keybinding"), "those to commands Sulfur has")
	}
	code := str(m["main"]) != "" || str(m["browser"]) != ""
	if usesLanguageClient(m) {
		add("languageServer", vsxPartial, "language server", "if the package carries it")
	} else if code {
		// a client bundled without its dependencies listed (sumneko.lua's): told by what it activates on
		for _, ev := range asList(m["activationEvents"]) {
			if strings.HasPrefix(str(ev), "onLanguage:") {
				add("languageServer", vsxPartial, "language server?", "if its code starts one the package carries")
				break
			}
		}
	}
	web := str(m["browser"]) != ""
	if web {
		add("code", vsxPartial, "web build", "runs sandboxed under Sulfur's VS Code API shim")
		if n := len(asList(c["customEditors"])); n > 0 {
			add("customEditors", vsxConverted, plural(n, "custom editor"), "in webview tabs")
		}
		if n := len(asList(c["commands"])); n > 0 {
			add("commands", vsxConverted, plural(n, "command"), "run by its web build")
		}
		if len(asMap(c["views"])) > 0 {
			add("views", vsxPartial, "sidebar views", "native containers for webview and tree providers; conditional visibility and view menus are not translated")
		}
	} else if code {
		detail := "Node.js code: Sulfur has no Node extension host"
		if c["views"] != nil || c["customEditors"] != nil || c["viewsContainers"] != nil {
			detail += "; its UI is drawn by that code"
		}
		add("code", vsxSkipped, "extension code", detail)
	}
	var other []string
	for k := range c {
		if _, ok := vsxUnsupported[k]; ok && !(web && (k == "commands" || k == "customEditors" || k == "views" || k == "viewsContainers")) {
			other = append(other, k)
		}
	}
	sort.Strings(other)
	if len(other) > 0 {
		add("other", vsxSkipped, strings.Join(other, ", "), "")
	}
	if n := len(asList(m["extensionPack"])); n > 0 {
		add("extensionPack", vsxSkipped, plural(n, "bundled extension"), "convert each on its own")
	}
	if n := len(asList(m["extensionDependencies"])); n > 0 {
		add("dependencies", vsxPartial, plural(n, "dependency"), "checked against installed Sulfur extensions; convert missing dependencies separately")
	}
	return out
}

func plural(n int, s string) string {
	if n == 1 {
		return "1 " + s
	}
	return strconv.Itoa(n) + " " + s + "s"
}

// --- converting --------------------------------------------------------------------

var idClean = regexp.MustCompile(`[^a-z0-9._-]+`)

// VSXID the Sulfur extension id (its folder's name) for a package
func VSXID(namespace, name string) string {
	id := idClean.ReplaceAllString(strings.ToLower(namespace+"."+name), "-")
	return strings.Trim(id, ".-")
}

type converter struct {
	pkg      *vsixPackage
	m        map[string]any
	opt      VSXOptions
	files    map[string]string
	report   []VSXReportItem
	total    int
	contrib  map[string]any
	langs    map[string]map[string]any // the package's languages by id, as written
	langList []string
	used     map[string]bool // written file names
	binary   map[string]string
	// a web build carried (vsx_web.go): its entry under vscode/, its settings' defaults
	web         string
	webDefaults map[string]any
	// a web build there was no reason to run
	webIdle bool
}

func (c *converter) add(kind, status, name, detail string) {
	c.report = append(c.report, VSXReportItem{Kind: kind, Status: status, Name: name, Detail: detail})
}

// write a file of the converted extension, a unique name under dir
func (c *converter) write(dir, base, text string) (string, error) {
	if c.total+len(text) > vsxTotalMax {
		return "", fmt.Errorf("the converted extension would be over %dMB", vsxTotalMax>>20)
	}
	base = idClean.ReplaceAllString(strings.ToLower(base), "-")
	name := dir + "/" + base + ".json"
	for i := 2; c.used[name]; i++ {
		name = fmt.Sprintf("%s/%s-%d.json", dir, base, i)
	}
	c.used[name] = true
	c.total += len(text)
	c.files[name] = text
	return name, nil
}

func jsonText(v any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	enc.Encode(v)
	return b.String()
}

func stem(rel string) string {
	b := path.Base(rel)
	for _, ext := range []string{".tmLanguage.json", ".tmLanguage", ".tmTheme", ".json", ".plist", ".code-snippets"} {
		if strings.HasSuffix(strings.ToLower(b), strings.ToLower(ext)) {
			return b[:len(b)-len(ext)]
		}
	}
	return strings.TrimSuffix(b, path.Ext(b))
}

// ConvertVSIX a .vsix made a Sulfur extension
func ConvertVSIX(data []byte, src VSXSource, opt VSXOptions) (*VSXConversion, error) {
	pkg, err := openVSIX(data)
	if err != nil {
		return nil, err
	}
	b, err := pkg.read("package.json")
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(stripJSONC(b), &m); err != nil || m == nil {
		return nil, errors.New("package.json isn't a JSON object")
	}
	if src.Namespace == "" {
		src.Namespace = str(m["publisher"])
	}
	if src.Name == "" {
		src.Name = str(m["name"])
	}
	if src.Version == "" {
		src.Version = str(m["version"])
	}
	if src.Namespace == "" || src.Name == "" {
		return nil, errors.New("package.json names no publisher and name")
	}
	c := &converter{pkg: pkg, m: m, opt: opt, files: map[string]string{}, binary: map[string]string{}, contrib: map[string]any{}, langs: map[string]map[string]any{}, used: map[string]bool{}}
	contributes := asMap(m["contributes"])
	browser := c.webBuild()
	c.languages(asList(contributes["languages"]))
	c.grammars(asList(contributes["grammars"]))
	c.themes(asList(contributes["themes"]))
	c.iconThemes(asList(contributes["iconThemes"]))
	c.snippets(asList(contributes["snippets"]))
	server := c.languageServer(contributes)
	runWeb := browser != "" && c.wantsWeb(contributes, browser, server)
	c.webIdle = browser != "" && !runWeb
	c.keybindings(asList(contributes["keybindings"]), asList(contributes["commands"]), runWeb)
	if runWeb {
		c.webExtension(contributes, browser)
	}
	c.rest(contributes, server)
	if len(c.langList) > 0 {
		list := []any{}
		for _, id := range c.langList {
			list = append(list, c.langs[id])
		}
		c.contrib["languages"] = list
	}

	id := VSXID(src.Namespace, src.Name)
	display := pkg.localize(m["displayName"])
	if display == "" {
		display = src.Name
	}
	sulfurPart := map[string]any{
		"declarative": c.web == "",
		"converted":   src,
		"report":      c.report,
	}
	manifest := map[string]any{
		"name":        id,
		"displayName": display,
		"version":     src.Version,
		"description": pkg.localize(m["description"]),
		"publisher":   src.Namespace,
		"contributes": c.contrib,
		"sulfur":      sulfurPart,
	}
	if c.web != "" {
		// its web build is its main module, run under the VS Code API shim
		manifest["main"] = c.web
		sulfurPart["vscode"] = map[string]any{"root": vsxWebDir, "id": src.Namespace + "." + src.Name, "defaults": c.webDefaults}
	}
	if s := str(m["license"]); s != "" {
		manifest["license"] = s
	}
	if dependencies := asList(m["extensionDependencies"]); len(dependencies) > 0 {
		manifest["extensionDependencies"] = dependencies
		c.add("dependencies", vsxPartial, plural(len(dependencies), "dependency"), "checked against installed Sulfur extensions; cross-extension executable exports are not shared across sandboxes")
		sulfurPart["report"] = c.report
	}
	c.files["package.json"] = jsonText(manifest)
	c.files["README.md"] = c.readme(display, src)
	return &VSXConversion{ID: id, Manifest: manifest, Files: c.files, Binary: c.binary, Report: c.report}, nil
}

func (c *converter) readme(display string, src VSXSource) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\nConverted from the VS Code extension [%s.%s](https://open-vsx.org/extension/%s/%s) %s on Open VSX. ", display, src.Namespace, src.Name, src.Namespace, src.Name, src.Version)
	if c.web != "" {
		b.WriteString("Themes, icons, languages, grammars and snippets use Sulfur's native editor features. Its web build runs in a sandbox for commands and custom editors; unsupported VS Code APIs are reported in its output.\n")
	} else {
		b.WriteString("Sulfur reads what it declares; none of its own code runs.\n")
	}
	b.WriteString("\n## Conversion\n\n| | what | status | |\n|---|---|---|---|\n")
	for _, r := range c.report {
		fmt.Fprintf(&b, "| %s | %s | %s | %s |\n", r.Kind, mdCell(r.Name), r.Status, mdCell(r.Detail))
	}
	for _, name := range []string{"README.md", "readme.md", "Readme.md", "README.MD", "README"} {
		if t, err := c.pkg.read(name); err == nil && utf8.Valid(t) {
			if len(t) > 200<<10 {
				t = t[:200<<10]
			}
			b.WriteString("\n## The extension's own README\n\n")
			b.Write(t)
			break
		}
	}
	return b.String()
}

func mdCell(s string) string { return strings.NewReplacer("|", "\\|", "\n", " ").Replace(s) }

// --- languages and their configurations ---------------------------------------------

func splitWords(s string) []string { return strings.Fields(s) }

// languageEntry the package's language of id, made from VS Code's own when it has none
func (c *converter) languageEntry(id string) map[string]any {
	if l := c.langs[id]; l != nil {
		return l
	}
	l := map[string]any{"id": id, "extensions": []string{}, "filenames": []string{}}
	if known, ok := vscodeLanguages[id]; ok {
		l["extensions"] = splitWords(known[0])
		l["filenames"] = splitWords(known[1])
	}
	c.langs[id] = l
	c.langList = append(c.langList, id)
	return l
}

// extensionsOf a language's extensions and file names, the package's or VS Code's
func (c *converter) extensionsOf(id string) ([]string, []string) {
	if l := c.langs[id]; l != nil {
		e, _ := l["extensions"].([]string)
		f, _ := l["filenames"].([]string)
		return e, f
	}
	if known, ok := vscodeLanguages[id]; ok {
		return splitWords(known[0]), splitWords(known[1])
	}
	return nil, nil
}

func appendUnique(list []string, add ...string) []string {
	for _, a := range add {
		found := false
		for _, x := range list {
			if x == a {
				found = true
				break
			}
		}
		if !found && a != "" {
			list = append(list, a)
		}
	}
	return list
}

func (c *converter) languages(list []any) {
	for _, raw := range list {
		l := asMap(raw)
		id := str(l["id"])
		if id == "" {
			continue
		}
		e := c.languageEntry(id)
		var exts, names, notes []string
		for _, x := range asList(l["extensions"]) {
			exts = append(exts, strings.TrimPrefix(strings.ToLower(str(x)), "."))
		}
		for _, x := range asList(l["filenames"]) {
			names = append(names, strings.ToLower(str(x)))
		}
		e["extensions"] = appendUnique(e["extensions"].([]string), exts...)
		e["filenames"] = appendUnique(e["filenames"].([]string), names...)
		if a := asList(l["aliases"]); len(a) > 0 {
			if _, had := e["aliases"]; !had {
				e["aliases"] = a
			}
		}
		if len(asList(l["filenamePatterns"])) > 0 {
			notes = append(notes, "filename patterns aren't matched")
		}
		if str(l["firstLine"]) != "" {
			notes = append(notes, "first-line detection isn't done")
		}
		if cfg := str(l["configuration"]); cfg != "" {
			notes = append(notes, c.languageConfiguration(e, cleanRel("", cfg))...)
		}
		name := id
		if a := asList(e["aliases"]); len(a) > 0 && str(a[0]) != "" {
			name = str(a[0])
		}
		status, detail := vsxConverted, ""
		if len(exts)+len(names) == 0 && vscodeLanguages[id][0] == "" {
			notes = append(notes, "it names no file extensions")
		}
		if len(notes) > 0 {
			status, detail = vsxPartial, strings.Join(notes, "; ")
		}
		c.add("language", status, name, detail)
	}
}

func (c *converter) languageConfiguration(e map[string]any, rel string) []string {
	v, err := c.pkg.readData(rel)
	if err != nil {
		return []string{"its configuration couldn't be read: " + err.Error()}
	}
	cfg := asMap(v)
	var notes []string
	if cm := asMap(cfg["comments"]); cm != nil {
		out := map[string]any{}
		if s := str(cm["lineComment"]); s != "" {
			out["lineComment"] = s
		} else if lc := asMap(cm["lineComment"]); lc != nil && str(lc["comment"]) != "" {
			out["lineComment"] = str(lc["comment"])
		}
		if bc := asList(cm["blockComment"]); len(bc) == 2 && str(bc[0]) != "" && str(bc[1]) != "" {
			out["blockComment"] = []string{str(bc[0]), str(bc[1])}
		}
		e["comments"] = out
	}
	pairs := func(k string) []any {
		var out []any
		for _, p := range asList(cfg[k]) {
			switch x := p.(type) {
			case []any:
				if len(x) == 2 && str(x[0]) != "" && str(x[1]) != "" {
					out = append(out, []string{str(x[0]), str(x[1])})
				}
			case map[string]any:
				if str(x["open"]) != "" && str(x["close"]) != "" {
					out = append(out, []string{str(x["open"]), str(x["close"])})
				}
			}
		}
		return out
	}
	if b := pairs("brackets"); len(b) > 0 {
		e["brackets"] = b
	}
	if b := pairs("autoClosingPairs"); len(b) > 0 {
		e["autoClosingPairs"] = b
	}
	var skipped []string
	for _, k := range []string{"indentationRules", "onEnterRules", "wordPattern", "folding"} {
		if cfg[k] != nil {
			skipped = append(skipped, k)
		}
	}
	if len(skipped) > 0 {
		notes = append(notes, strings.Join(skipped, ", ")+" not used")
	}
	return notes
}

// --- grammars --------------------------------------------------------------------------

func (c *converter) grammars(list []any) {
	for _, raw := range list {
		g := asMap(raw)
		scope, rel := str(g["scopeName"]), cleanRel("", str(g["path"]))
		lang := str(g["language"])
		name := scope
		if rel == "" || scope == "" {
			c.add("grammar", vsxSkipped, name, "no scopeName or path")
			continue
		}
		if lang == "" {
			if len(asList(g["injectTo"])) > 0 {
				c.add("grammar", vsxSkipped, name, "an injection into other grammars, which Sulfur doesn't apply")
			} else {
				c.add("grammar", vsxSkipped, name, "a grammar for no language, only included by others")
				// still written: another grammar of the package may include it by scope
				if v, err := c.pkg.readData(rel); err == nil {
					if file, err := c.write("syntaxes", stem(rel), jsonText(v)); err == nil {
						c.appendContrib("grammars", map[string]any{"scopeName": scope, "path": file})
					}
				}
			}
			continue
		}
		v, err := c.pkg.readData(rel)
		if err != nil {
			c.add("grammar", vsxSkipped, name, err.Error())
			continue
		}
		gm := asMap(v)
		if gm == nil || (gm["patterns"] == nil && gm["repository"] == nil) {
			c.add("grammar", vsxSkipped, name, "not a TextMate grammar")
			continue
		}
		file, err := c.write("syntaxes", stem(rel), jsonText(gm))
		if err != nil {
			c.add("grammar", vsxSkipped, name, err.Error())
			continue
		}
		entry := map[string]any{"language": lang, "scopeName": scope, "path": file}
		if em := asMap(g["embeddedLanguages"]); len(em) > 0 {
			entry["embeddedLanguages"] = em
		}
		c.appendContrib("grammars", entry)
		c.languageEntry(lang)
		exts, _ := c.extensionsOf(lang)
		var own []string
		for _, e := range exts {
			if sulfurParsed[e] {
				own = append(own, "."+e)
			}
		}
		detail := "for " + lang
		status := vsxConverted
		if len(own) > 0 && len(own) == len(exts) {
			status, detail = vsxPartial, "Sulfur's own parser keeps highlighting "+strings.Join(own, " ")+" files"
		} else if len(own) > 0 {
			detail += "; Sulfur's own parser keeps " + strings.Join(own, " ")
		}
		if len(asList(gm["injections"])) > 0 || asMap(gm["injections"]) != nil {
			status, detail = vsxPartial, detail+"; its injections aren't applied"
		}
		c.add("grammar", status, name, detail)
	}
}

func (c *converter) appendContrib(k string, v any) {
	list, _ := c.contrib[k].([]any)
	c.contrib[k] = append(list, v)
}

// --- color themes ---------------------------------------------------------------------

var colorRe = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)

// the workbench's tokens from a VS Code theme's colors: each the first of its keys the theme sets
var themeVars = [][]string{
	{"--ide-bg", "editor.background"},
	{"--ide-side", "sideBar.background", "editor.background"},
	{"--ide-fg", "foreground", "editor.foreground"},
	{"--ide-strong", "editor.foreground", "foreground"},
	{"--ide-muted", "descriptionForeground", "sideBarSectionHeader.foreground", "editorLineNumber.foreground"},
	{"--ide-dim", "disabledForeground", "editorLineNumber.foreground"},
	{"--ide-border", "panel.border", "sideBar.border", "editorGroup.border", "contrastBorder", "tab.border"},
	{"--ide-accent", "focusBorder", "activityBarBadge.background", "button.background"},
	{"--ide-link", "textLink.foreground"},
	{"--ide-hover", "list.hoverBackground"},
	{"--ide-sel", "list.activeSelectionBackground"},
	{"--ide-sel-off", "list.inactiveSelectionBackground"},
	{"--ide-input", "input.background"},
	{"--ide-input-border", "input.border"},
	{"--ide-button", "button.background"},
	{"--ide-button-hover", "button.hoverBackground"},
	{"--ide-button-fg", "button.foreground"},
	{"--ide-second", "button.secondaryBackground"},
	{"--ide-second-hover", "button.secondaryHoverBackground"},
	{"--ide-second-fg", "button.secondaryForeground"},
	{"--ide-widget", "editorWidget.background", "editorSuggestWidget.background"},
	{"--ide-widget-border", "editorWidget.border", "editorSuggestWidget.border"},
	{"--ide-badge", "badge.background"},
	{"--ide-badge-fg", "badge.foreground"},
	{"--ide-err", "errorForeground", "editorError.foreground"},
	{"--ide-warn", "editorWarning.foreground", "list.warningForeground"},
	{"--ide-info", "editorInfo.foreground"},
	{"--ide-ok", "gitDecoration.addedResourceForeground", "terminal.ansiGreen"},
	{"--ide-hl", "list.highlightForeground"},
	{"--ide-find", "editor.findMatchHighlightBackground"},
	{"--ide-find-now", "editor.findMatchBackground"},
	{"--ide-guide", "editorIndentGuide.background1", "editorIndentGuide.background"},
	{"--ide-indent-guide", "editorIndentGuide.background1", "editorIndentGuide.background"},
	{"--ide-scroll", "scrollbarSlider.background"},
	{"--ide-ed-sel", "editor.selectionBackground"},
	{"--ide-selection", "editor.selectionBackground"},
	{"--ide-line-nr", "editorLineNumber.foreground"},
	{"--ide-line-nr-now", "editorLineNumber.activeForeground"},
	{"--ide-caret", "editorCursor.foreground"},
	{"--ide-line-hl", "editor.lineHighlightBackground"},
	{"--ide-line-border", "editor.lineHighlightBorder"},
	{"--ide-bracket", "editorBracketMatch.background"},
	{"--ide-bracket-border", "editorBracketMatch.border"},
	{"--ide-word-hl", "editor.wordHighlightBackground"},
	{"--ide-ruler", "editorRuler.foreground"},
	{"--ide-whitespace", "editorWhitespace.foreground"},
	{"--ide-title-bg", "titleBar.activeBackground"},
	{"--ide-git-modified", "gitDecoration.modifiedResourceForeground"},
	{"--ide-git-added", "gitDecoration.addedResourceForeground"},
	{"--ide-git-untracked", "gitDecoration.untrackedResourceForeground"},
	{"--ide-git-deleted", "gitDecoration.deletedResourceForeground"},
	{"--ide-git-renamed", "gitDecoration.renamedResourceForeground"},
	{"--ide-git-conflict", "gitDecoration.conflictingResourceForeground"},
}

// the syntax tokens from token colors: each the first of its scopes a rule colors
var themeTokens = [][]string{
	{"--hl-kw", "keyword.control", "keyword", "storage.type", "storage"},
	{"--hl-str", "string.quoted.double", "string.quoted", "string"},
	{"--hl-num", "constant.numeric"},
	{"--hl-title", "entity.name.function", "support.function"},
	{"--hl-type", "entity.name.type", "entity.name.class", "support.type", "support.class"},
	{"--hl-attr", "variable.other.property", "entity.other.attribute-name", "support.type.property-name", "variable.other"},
	{"--hl-meta", "meta.preprocessor", "keyword.control.directive", "keyword.other.preprocessor", "entity.name.function.preprocessor"},
	{"--hl-cmt", "comment.line", "comment"},
	{"--hl-del", "markup.deleted", "invalid"},
}

type tokenRule struct {
	scopes     []string
	foreground string
	fontStyle  string
	hasStyle   bool
}

// themeData a theme file with what it includes merged under it
func (c *converter) themeData(rel string, depth int) (map[string]any, []tokenRule, error) {
	if depth > 4 {
		return nil, nil, errors.New("themes include each other too deep")
	}
	v, err := c.pkg.readData(rel)
	if err != nil {
		return nil, nil, err
	}
	t := asMap(v)
	if t == nil {
		return nil, nil, errors.New("not a theme")
	}
	colors := map[string]any{}
	var rules []tokenRule
	if inc := str(t["include"]); inc != "" {
		ic, ir, err := c.themeData(cleanRel(path.Dir(rel), inc), depth+1)
		if err != nil {
			return nil, nil, err
		}
		colors, rules = ic, ir
	}
	for k, x := range asMap(t["colors"]) {
		colors[k] = x
	}
	var tc []any
	switch x := t["tokenColors"].(type) {
	case string:
		tv, err := c.pkg.readData(cleanRel(path.Dir(rel), x))
		if err != nil {
			return nil, nil, err
		}
		tc = asList(asMap(tv)["settings"])
		if tc == nil {
			tc = asList(asMap(tv)["tokenColors"])
		}
	case []any:
		tc = x
	}
	// a .tmTheme on its own: its settings are the token colors, the first the editor's
	if tc == nil && t["settings"] != nil {
		tc = asList(t["settings"])
	}
	for _, r := range tc {
		rm := asMap(r)
		s := asMap(rm["settings"])
		if s == nil {
			continue
		}
		var scopes []string
		for _, sc := range asList(rm["scope"]) {
			for _, part := range strings.Split(str(sc), ",") {
				if part = strings.TrimSpace(part); part != "" {
					scopes = append(scopes, part)
				}
			}
		}
		if len(scopes) == 0 {
			// the scope-less rule: the editor's own colors, a .tmTheme's way
			for k, ck := range map[string]string{"background": "editor.background", "foreground": "editor.foreground", "caret": "editorCursor.foreground", "selection": "editor.selectionBackground", "lineHighlight": "editor.lineHighlightBackground"} {
				if v := str(s[k]); v != "" && colors[ck] == nil {
					colors[ck] = v
				}
			}
			continue
		}
		fs, has := s["fontStyle"].(string)
		rules = append(rules, tokenRule{scopes: scopes, foreground: str(s["foreground"]), fontStyle: fs, hasStyle: has})
	}
	return colors, rules, nil
}

// matchToken the best rule's foreground and font style for a scope, TextMate's way: the
// longest selector that is the scope or its prefix, the later rule at a tie. A selector
// with parents ("meta.x string") colors its context alone, which Sulfur's syntax tokens
// don't have: left out
func matchToken(rules []tokenRule, scope string) (fg, style string, styled bool) {
	best, bestStyle := -1, -1
	for _, r := range rules {
		for _, sel := range r.scopes {
			parts := strings.Fields(sel)
			if len(parts) != 1 || strings.HasPrefix(sel, "-") {
				continue
			}
			last := parts[0]
			if last != scope && !strings.HasPrefix(scope, last+".") {
				continue
			}
			spec := strings.Count(last, ".") + 1
			if r.foreground != "" && colorRe.MatchString(r.foreground) && spec >= best {
				best, fg = spec, r.foreground
			}
			if r.hasStyle && spec >= bestStyle {
				bestStyle, style, styled = spec, r.fontStyle, true
			}
		}
	}
	return
}

func (c *converter) themes(list []any) {
	for _, raw := range list {
		t := asMap(raw)
		rel := cleanRel("", str(t["path"]))
		label := c.pkg.localize(t["label"])
		if label == "" {
			label = str(t["id"])
		}
		if label == "" {
			label = stem(rel)
		}
		if rel == "" {
			c.add("theme", vsxSkipped, label, "no path")
			continue
		}
		colors, rules, err := c.themeData(rel, 0)
		if err != nil {
			c.add("theme", vsxSkipped, label, err.Error())
			continue
		}
		kind := "dark"
		switch str(t["uiTheme"]) {
		case "vs":
			kind = "light"
		case "hc-black":
			kind = "hc-dark"
		case "hc-light":
			kind = "hc-light"
		}
		vars := map[string]string{}
		for _, spec := range themeVars {
			for _, k := range spec[1:] {
				if s := str(colors[k]); colorRe.MatchString(s) {
					vars[spec[0]] = s
					break
				}
			}
		}
		if s := str(colors["widget.shadow"]); colorRe.MatchString(s) {
			vars["--ide-shadow"] = "0 0 8px 2px " + s
		}
		syntax := 0
		for _, spec := range themeTokens {
			for _, sc := range spec[1:] {
				if fg, _, _ := matchToken(rules, sc); fg != "" {
					vars[spec[0]] = fg
					syntax++
					break
				}
			}
		}
		if _, style, ok := matchToken(rules, "comment.line"); ok {
			if strings.Contains(style, "italic") {
				vars["--hl-cmt-style"] = "italic"
			} else {
				vars["--hl-cmt-style"] = "normal"
			}
		}
		if len(vars) == 0 {
			c.add("theme", vsxSkipped, label, "it sets no colors Sulfur has")
			continue
		}
		id := str(t["id"])
		if id == "" {
			id = label
		}
		file, err := c.write("themes", stem(rel), jsonText(map[string]any{"label": label, "type": kind, "vars": vars}))
		if err != nil {
			c.add("theme", vsxSkipped, label, err.Error())
			continue
		}
		c.appendContrib("themes", map[string]any{"id": idClean.ReplaceAllString(strings.ToLower(id), "-"), "label": label, "uiTheme": kind, "path": file})
		ui := len(vars) - syntax
		if _, ok := vars["--hl-cmt-style"]; ok {
			ui--
		}
		detail := fmt.Sprintf("%d of its %d workbench colors and %d of Sulfur's 9 syntax colors (from %d token rules)", ui, len(colors), syntax, len(rules))
		status := vsxConverted
		if syntax < 4 || ui < 4 {
			status = vsxPartial
		}
		c.add("theme", status, label, detail)
	}
}

// --- file icon themes -----------------------------------------------------------------

var (
	fontSizeRe = regexp.MustCompile(`^\d+(\.\d+)?(%|px|em)$`)
	fontWordRe = regexp.MustCompile(`^(normal|bold|italic|oblique|[1-9]00)$`)
)

var mimeOf = map[string]string{".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
	".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf"}

func (c *converter) dataURL(rel string) (string, error) {
	mime := mimeOf[strings.ToLower(path.Ext(rel))]
	if mime == "" {
		return "", fmt.Errorf("%s: not an image or font Sulfur shows", rel)
	}
	b, err := c.pkg.read(rel)
	if err != nil {
		return "", err
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(b), nil
}

// fontChar a VS Code fontCharacter ("\E001", "\\E001", "a") as the character
func fontChar(s string) string {
	t := strings.TrimLeft(s, "\\")
	if t != s && len(t) >= 1 && len(t) <= 6 {
		if n, err := strconv.ParseUint(t, 16, 32); err == nil && utf8.ValidRune(rune(n)) {
			return string(rune(n))
		}
	}
	return s
}

var iconMaps = []string{"fileExtensions", "fileNames", "folderNames", "folderNamesExpanded", "rootFolderNames", "rootFolderNamesExpanded", "languageIds"}
var iconSingles = []string{"file", "folder", "folderExpanded", "rootFolder", "rootFolderExpanded"}

func (c *converter) iconThemes(list []any) {
	for _, raw := range list {
		t := asMap(raw)
		rel := cleanRel("", str(t["path"]))
		label := c.pkg.localize(t["label"])
		if label == "" {
			label = str(t["id"])
		}
		v, err := c.pkg.readData(rel)
		th := asMap(v)
		if err != nil || th == nil {
			if err == nil {
				err = errors.New("not an icon theme")
			}
			c.add("iconTheme", vsxSkipped, label, err.Error())
			continue
		}
		dir := path.Dir(rel)
		defs := asMap(th["iconDefinitions"])
		// only what the theme's maps use is inlined
		used := map[string]bool{}
		maps := func(src map[string]any) map[string]any {
			out := map[string]any{}
			for _, k := range iconSingles {
				if s := str(src[k]); s != "" && defs[s] != nil {
					out[k] = s
					used[s] = true
				}
			}
			for _, k := range iconMaps {
				mm := map[string]string{}
				for name, idv := range asMap(src[k]) {
					if s := str(idv); s != "" && defs[s] != nil {
						mm[strings.ToLower(name)] = s
						used[s] = true
					}
				}
				if len(mm) > 0 {
					out[k] = mm
				}
			}
			return out
		}
		out := maps(th)
		if light := maps(asMap(th["light"])); len(light) > 0 {
			out["light"] = light
		}
		// languageIds resolved to extensions and names here, the page knowing no language ids
		resolve := func(o map[string]any) {
			ids, _ := o["languageIds"].(map[string]string)
			if len(ids) == 0 {
				return
			}
			le, ln := map[string]string{}, map[string]string{}
			for lang, icon := range ids {
				exts, names := c.extensionsOf(lang)
				for _, e := range exts {
					le[e] = icon
				}
				for _, n := range names {
					ln[n] = icon
				}
			}
			o["languageExtensions"], o["languageFileNames"] = le, ln
			delete(o, "languageIds")
		}
		resolve(out)
		if light, ok := out["light"].(map[string]any); ok {
			resolve(light)
		}
		fonts := map[string]any{}
		var problems []string
		for _, f := range asList(th["fonts"]) {
			fm := asMap(f)
			id := str(fm["id"])
			if id == "" {
				continue
			}
			for _, s := range asList(fm["src"]) {
				url, err := c.dataURL(cleanRel(dir, str(asMap(s)["path"])))
				if err != nil {
					problems = append(problems, err.Error())
					continue
				}
				font := map[string]any{"src": url}
				for _, k := range []string{"weight", "style"} {
					if w := str(fm[k]); fontWordRe.MatchString(w) {
						font[k] = w
					}
				}
				if sz := str(fm["size"]); fontSizeRe.MatchString(sz) {
					font["size"] = sz
				}
				fonts[idClean.ReplaceAllString(strings.ToLower(id), "-")] = font
				break
			}
		}
		outDefs := map[string]any{}
		missing := 0
		for id := range used {
			d := asMap(defs[id])
			if p := str(d["iconPath"]); p != "" {
				url, err := c.dataURL(cleanRel(dir, p))
				if err != nil {
					missing++
					continue
				}
				outDefs[id] = map[string]any{"src": url}
			} else if ch := str(d["fontCharacter"]); ch != "" {
				def := map[string]any{"char": fontChar(ch)}
				if col := str(d["fontColor"]); colorRe.MatchString(col) {
					def["color"] = col
				}
				fid := idClean.ReplaceAllString(strings.ToLower(str(d["fontId"])), "-")
				if fid == "" {
					for k := range fonts {
						fid = k
						break
					}
				}
				if fonts[fid] == nil {
					missing++
					continue
				}
				def["font"] = fid
				if sz := str(d["fontSize"]); fontSizeRe.MatchString(sz) {
					def["size"] = sz
				}
				outDefs[id] = def
			} else {
				missing++
			}
		}
		if len(outDefs) == 0 {
			c.add("iconTheme", vsxSkipped, label, "none of its icons could be read")
			continue
		}
		out["label"], out["defs"], out["fonts"] = label, outDefs, fonts
		if th["hidesExplorerArrows"] == true {
			out["hidesExplorerArrows"] = true
		}
		file, err := c.write("icons", stem(rel), jsonText(out))
		if err != nil {
			c.add("iconTheme", vsxSkipped, label, err.Error())
			continue
		}
		id := str(t["id"])
		if id == "" {
			id = label
		}
		c.appendContrib("iconThemes", map[string]any{"id": idClean.ReplaceAllString(strings.ToLower(id), "-"), "label": label, "path": file})
		status, detail := vsxConverted, fmt.Sprintf("%d icons", len(outDefs))
		if len(fonts) > 0 {
			detail += fmt.Sprintf(" (%s)", plural(len(fonts), "icon font"))
		}
		if missing > 0 || len(problems) > 0 {
			status = vsxPartial
			detail += fmt.Sprintf("; %d couldn't be read", missing+len(problems))
		}
		if th["highContrast"] != nil {
			detail += "; its high-contrast set isn't used"
		}
		c.add("iconTheme", status, label, detail)
	}
}

// --- snippets ----------------------------------------------------------------------------

var (
	snippetTransformRe = regexp.MustCompile(`\$\{\d+/`)
	snippetVariableRe  = regexp.MustCompile(`\$\{?(TM_|CLIPBOARD|WORKSPACE_|CURRENT_|RELATIVE_FILEPATH|LINE_COMMENT|BLOCK_COMMENT|UUID|RANDOM|CURSOR_)`)
)

func joinBody(v any) string {
	if a, ok := v.([]any); ok {
		lines := make([]string, len(a))
		for i, x := range a {
			lines[i] = str(x)
		}
		return strings.Join(lines, "\n")
	}
	return str(v)
}

func (c *converter) snippets(list []any) {
	// a file several languages share converted once, for all of them
	var order []string
	byPath := map[string][]string{}
	for _, raw := range list {
		s := asMap(raw)
		rel := cleanRel("", str(s["path"]))
		if _, had := byPath[rel]; !had {
			order = append(order, rel)
		}
		byPath[rel] = appendUnique(byPath[rel], str(s["language"]))
	}
	for _, rel := range order {
		langList := byPath[rel]
		lang := strings.Join(langList, ", ")
		name := path.Base(rel)
		if rel == "" {
			name = "a snippet file outside the package"
		}
		if lang != "" {
			name = lang + ": " + name
		}
		v, err := c.pkg.readData(rel)
		if err != nil {
			c.add("snippets", vsxSkipped, name, err.Error())
			continue
		}
		var out []any
		names := []string{}
		for k := range asMap(v) {
			names = append(names, k)
		}
		sort.Strings(names)
		odd := 0
		langs := map[string]bool{}
		for _, l := range langList {
			langs[l] = true
		}
		for _, k := range names {
			sn := asMap(asMap(v)[k])
			if sn == nil || sn["body"] == nil {
				continue
			}
			var prefixes []string
			for _, p := range asList(sn["prefix"]) {
				if s := str(p); s != "" {
					prefixes = append(prefixes, s)
				}
			}
			if len(prefixes) == 0 {
				continue
			}
			body := joinBody(sn["body"])
			if snippetTransformRe.MatchString(body) || snippetVariableRe.MatchString(body) {
				odd++
			}
			item := map[string]any{"name": k, "prefix": prefixes, "body": body}
			if d := joinBody(sn["description"]); d != "" {
				item["description"] = d
			}
			if sc := str(sn["scope"]); sc != "" {
				var scopes []string
				for _, x := range strings.Split(sc, ",") {
					if x = strings.TrimSpace(x); x != "" {
						scopes = append(scopes, x)
						langs[x] = true
					}
				}
				item["scope"] = scopes
			}
			out = append(out, item)
		}
		if len(out) == 0 {
			c.add("snippets", vsxSkipped, name, "no snippets in it")
			continue
		}
		file, err := c.write("snippets", strings.Trim(langList[0]+"-"+stem(rel), "-"), jsonText(out))
		if err != nil {
			c.add("snippets", vsxSkipped, name, err.Error())
			continue
		}
		// the languages' files said here, the page knowing extensions, not language ids
		var exts, fnames []string
		for l := range langs {
			e, f := c.extensionsOf(l)
			exts, fnames = appendUnique(exts, e...), appendUnique(fnames, f...)
		}
		sort.Strings(exts)
		sort.Strings(fnames)
		entry := map[string]any{"language": langList[0], "languages": langList, "path": file, "extensions": exts, "filenames": fnames}
		c.appendContrib("snippets", entry)
		status, detail := vsxConverted, plural(len(out), "snippet")
		if len(exts)+len(fnames) == 0 {
			status, detail = vsxPartial, detail+"; Sulfur doesn't know which files "+lang+" means"
		}
		if odd > 0 {
			status = vsxPartial
			detail += fmt.Sprintf("; %d use variables or transforms, inserted without them", odd)
		}
		c.add("snippets", status, name, detail)
	}
}

// --- keybindings -------------------------------------------------------------------------

func (c *converter) keybindings(list, commands []any, web bool) {
	if len(list) == 0 {
		return
	}
	own := map[string]bool{}
	for _, x := range commands {
		own[str(asMap(x)["command"])] = true
	}
	var kept []any
	var noCmd, ownCmd []string
	when := 0
	for _, raw := range list {
		k := asMap(raw)
		cmd, key := str(k["command"]), str(k["key"])
		if cmd == "" || key == "" {
			continue
		}
		bare := strings.TrimPrefix(cmd, "-")
		if own[bare] && !web {
			ownCmd = append(ownCmd, bare)
			continue
		}
		if !own[bare] && !c.opt.Commands[bare] {
			noCmd = append(noCmd, bare)
			continue
		}
		kb := map[string]any{"command": cmd, "key": strings.ToLower(key), "own": own[bare]}
		if mac := str(k["mac"]); mac != "" {
			kb["mac"] = strings.ToLower(mac)
		}
		if str(k["when"]) != "" {
			when++
		}
		if k["args"] != nil {
			kb["args"] = k["args"]
		}
		kept = append(kept, kb)
	}
	if len(kept) > 0 {
		c.contrib["keybindings"] = kept
	}
	status := vsxConverted
	detail := plural(len(kept), "keybinding") + " to Sulfur's commands"
	if len(kept) == 0 {
		status = vsxSkipped
		detail = "none bind a command Sulfur has"
	} else if len(noCmd)+len(ownCmd) > 0 || when > 0 {
		status = vsxPartial
	}
	if when > 0 {
		detail += fmt.Sprintf("; %d `when` conditions dropped, the keys bound everywhere", when)
	}
	if len(ownCmd) > 0 {
		detail += fmt.Sprintf("; %d to the extension's own commands, which need its code", len(ownCmd))
	}
	if len(noCmd) > 0 {
		sample := noCmd
		if len(sample) > 4 {
			sample = sample[:4]
		}
		detail += fmt.Sprintf("; %d to commands Sulfur hasn't (%s)", len(noCmd), strings.Join(sample, ", "))
	}
	c.add("keybindings", status, plural(len(list), "keybinding"), detail)
}

// --- a language server the package carries ------------------------------------------------

var (
	serverNameRe    = regexp.MustCompile(`(?i)(language[-_]?server|langserver|[-_]ls$|^ls[-_]|lsp|analyzer|server)`)
	notServerRe     = regexp.MustCompile(`(?i)((^|/)(node_modules/(vscode-languageserver|vscode-jsonrpc|vscode-languageclient)[^/]*/|tests?/|__tests__/)|\.d\.ts$|\.map$|[-.]web\.js$|browser|worker)`)
	langSelectorRe  = regexp.MustCompile(`language\s*:\s*["']([\w.+-]+)["']`)
	stringLiteralRe = regexp.MustCompile(`["'\x60]([\w./@-]{2,120})["'\x60]`)
)

// languageServer the server the package carries and how it's started, nil if none
func (c *converter) languageServer(contributes map[string]any) map[string]any {
	main := str(c.m["main"])
	if !usesLanguageClient(c.m) && main == "" {
		return nil
	}
	mainRel := cleanRel("", main)
	if mainRel != "" && path.Ext(mainRel) == "" {
		mainRel += ".js"
	}
	// the client's code: its main module and the modules beside it (bundled or not)
	code, _ := c.pkg.read(mainRel)
	if mainRel != "" {
		var rels []string
		for rel := range c.pkg.files {
			if path.Dir(rel) == path.Dir(mainRel) && rel != mainRel && strings.HasSuffix(rel, ".js") {
				rels = append(rels, rel)
			}
		}
		sort.Strings(rels)
		for _, rel := range rels {
			if len(code) > 8<<20 {
				break
			}
			if b, err := c.pkg.read(rel); err == nil {
				code = append(append(code, '\n'), b...)
			}
		}
	}
	if !usesLanguageClient(c.m) && !bytes.Contains(code, []byte("LanguageClient")) {
		return nil
	}
	// what the client's code names: the server's file is usually among its strings
	named := map[string]bool{}
	for _, m := range stringLiteralRe.FindAllSubmatch(code, -1) {
		s := strings.TrimPrefix(string(m[1]), "./")
		named[s] = true
		named[path.Base(s)] = true
		for _, part := range strings.Split(s, "/") {
			named[part] = true
		}
	}
	var best string
	bestScore, runtime := 0, ""
	for rel, f := range c.pkg.files {
		if notServerRe.MatchString(rel) || rel == mainRel {
			continue
		}
		base := path.Base(rel)
		ext := strings.ToLower(path.Ext(base))
		name := strings.TrimSuffix(base, path.Ext(base))
		native := ext == ".exe" || (ext == "" && f.Mode()&0o111 != 0) || (ext == "" && strings.Contains(rel, "/bin/"))
		if ext != ".js" && ext != ".cjs" && ext != ".mjs" && !native {
			continue
		}
		dir := path.Dir(rel)
		score := 0
		if serverNameRe.MatchString(name) {
			score += 4
		}
		if strings.Contains(strings.ToLower(dir), "server") {
			score += 3
		}
		if named[rel] {
			score += 6
		} else if named[base] || named[name] {
			score += 3
		}
		if native {
			score += 2
		}
		if strings.Contains(rel, "node_modules/") {
			score -= 2
		}
		if score < 5 {
			continue
		}
		if score > bestScore || (score == bestScore && rel < best) {
			best, bestScore = rel, score
			if native {
				runtime = "binary"
			} else {
				runtime = "node"
			}
		}
	}
	// the languages its client serves: activation events, its documents' selectors, its languages
	langs := []string{}
	for _, ev := range asList(c.m["activationEvents"]) {
		if s := str(ev); strings.HasPrefix(s, "onLanguage:") {
			langs = appendUnique(langs, strings.TrimPrefix(s, "onLanguage:"))
		}
	}
	for _, m := range langSelectorRe.FindAllSubmatch(code, -1) {
		langs = appendUnique(langs, string(m[1]))
	}
	// the languages it declares only when nothing else says
	if len(langs) == 0 {
		for _, l := range asList(contributes["languages"]) {
			langs = appendUnique(langs, str(asMap(l)["id"]))
		}
	}
	var exts, names, served []string
	languageIDs := map[string]string{}
	for _, l := range langs {
		e, n := c.extensionsOf(l)
		if len(e)+len(n) == 0 {
			continue
		}
		served = append(served, l)
		for _, x := range e {
			if _, had := languageIDs[x]; !had {
				languageIDs[x] = l
			}
		}
		exts, names = appendUnique(exts, e...), appendUnique(names, n...)
	}
	display := c.pkg.localize(c.m["displayName"])
	if display == "" {
		display = str(c.m["name"])
	}
	if best == "" {
		c.add("languageServer", vsxSkipped, display, "its client starts a server the package doesn't carry (downloaded, or found on PATH, by its code); install one of Sulfur's own language servers instead if it's listed")
		return nil
	}
	if len(exts)+len(names) == 0 {
		c.add("languageServer", vsxSkipped, best, "it serves no language Sulfur can tell the files of")
		return nil
	}
	sort.Strings(exts)
	settings := map[string]any{}
	for _, cfg := range asList(contributes["configuration"]) {
		for k, p := range asMap(asMap(cfg)["properties"]) {
			if d, ok := asMap(p)["default"]; ok {
				setPath(settings, strings.Split(k, "."), d)
			}
		}
	}
	// a node module's server talks over node IPC, as vscode-languageclient runs one
	// unless it asks for stdio; a program over stdio
	args, transport := []string{}, "stdio"
	if runtime == "node" {
		transport = "ipc"
		if bytes.Contains(code, []byte("TransportKind.stdio")) && !bytes.Contains(code, []byte("TransportKind.ipc")) {
			transport, args = "stdio", append(args, "--stdio")
		}
	}
	s := map[string]any{
		"name":      display,
		"runtime":   runtime,
		"transport": transport,
		// the client's initialization options naming the package's own files (yaml's l10nPath)
		"initializationOptions": clientInitOptions(code),
		"entry":                 "extension/" + best,
		"args":                  args,
		"languages":             served,
		"extensions":            exts,
		"filenames":             names,
		"languageIds":           languageIDs,
		"settings":              settings,
	}
	c.contrib["languageServers"] = []any{s}
	how := "node, over " + map[string]string{"ipc": "node IPC", "stdio": "stdio"}[transport]
	if runtime == "binary" {
		how = "a native program, over stdio"
	}
	c.add("languageServer", vsxPartial, best, fmt.Sprintf("found by its name, run as %s for %s; install it on a host from the extension's page. Its client's own middleware and commands don't run", how, strings.Join(served, ", ")))
	return s
}

var (
	initOptionsRe  = regexp.MustCompile(`initializationOptions\s*:\s*\{([^{}]{0,1000})\}`)
	initEntryRe    = regexp.MustCompile(`^\s*["']?([\w$]+)["']?\s*:\s*(.+?)\s*$`)
	absolutePathRe = regexp.MustCompile(`^[\w$.]*asAbsolutePath\(\s*["']([^"']+)["']\s*\)$`)
)

// clientInitOptions the initialization options a client's code passes that name files of
// its own package (asAbsolutePath("./dist/l10n"), directly or through a variable), as
// ${extensionPath}/... for the host to fill in with where it installed the package
func clientInitOptions(code []byte) map[string]any {
	out := map[string]any{}
	for _, m := range initOptionsRe.FindAllSubmatch(code, 8) {
		for _, part := range strings.Split(string(m[1]), ",") {
			kv := initEntryRe.FindStringSubmatch(part)
			if kv == nil {
				continue
			}
			value := kv[2]
			if !strings.Contains(value, "(") {
				// a variable: what it was set to
				if def := regexp.MustCompile(`(?:^|[^\w$.])` + regexp.QuoteMeta(value) + `\s*=\s*([\w$.]*asAbsolutePath\(\s*["'][^"']+["']\s*\))`).FindSubmatch(code); def != nil {
					value = string(def[1])
				}
			}
			if p := absolutePathRe.FindStringSubmatch(value); p != nil {
				if rel := cleanRel("", p[1]); rel != "" {
					out[kv[1]] = "${extensionPath}/" + rel
				}
			}
		}
	}
	return out
}

func setPath(m map[string]any, keys []string, v any) {
	for i, k := range keys {
		if i == len(keys)-1 {
			m[k] = v
			return
		}
		next, ok := m[k].(map[string]any)
		if !ok {
			next = map[string]any{}
			m[k] = next
		}
		m = next
	}
}

// --- what's left: settings, code, commands, every other point -------------------------------

func (c *converter) rest(contributes map[string]any, server map[string]any) {
	nSettings := 0
	for _, cfg := range asList(contributes["configuration"]) {
		nSettings += len(asMap(asMap(cfg)["properties"]))
	}
	if nSettings > 0 {
		if c.web != "" {
			c.add("settings", vsxPartial, plural(nSettings, "setting"), "their defaults are available to its sandboxed web build")
		} else if server != nil {
			c.add("settings", vsxPartial, plural(nSettings, "setting"), "their defaults are the language server's settings; change them under sulfur.languageServerSettings")
		} else {
			c.add("settings", vsxSkipped, plural(nSettings, "setting"), "read by the extension's code")
		}
	}
	if n := len(asMap(contributes["configurationDefaults"])); n > 0 {
		c.add("configurationDefaults", vsxSkipped, plural(n, "default"), "VS Code setting defaults; set what you want in Sulfur's settings")
	}
	web := c.web != ""
	if n := len(asList(contributes["commands"])); n > 0 && !web {
		c.add("commands", vsxSkipped, plural(n, "command"), vsxUnsupported["commands"])
	}
	if !web && (str(c.m["main"]) != "" || str(c.m["browser"]) != "") {
		detail := "Node.js code with no web build: it needs VS Code's Node extension host, which Sulfur doesn't have"
		ui := contributes["views"] != nil || contributes["customEditors"] != nil || contributes["viewsContainers"] != nil
		if ui {
			detail += "; its views, webviews and custom editors are drawn by that code, so they don't come"
		}
		if c.webIdle {
			detail = "its web build isn't run: beyond what's converted here it only adds VS Code commands and settings"
		}
		if server != nil {
			detail = "its language client is replaced by Sulfur's; anything else it does at run time isn't converted"
		}
		c.add("code", vsxSkipped, "extension code", detail)
	}
	var other []string
	for k := range contributes {
		if _, ok := vsxUnsupported[k]; ok && k != "commands" && !(web && (k == "customEditors" || k == "views" || k == "viewsContainers" || k == "webviews")) {
			other = append(other, k)
		}
	}
	sort.Strings(other)
	for _, k := range other {
		c.add(k, vsxSkipped, k, vsxUnsupported[k])
	}
	handled := map[string]bool{"themes": true, "iconThemes": true, "languages": true, "grammars": true, "snippets": true, "keybindings": true, "configuration": true, "configurationDefaults": true}
	var unknown []string
	for k := range contributes {
		if _, ok := vsxUnsupported[k]; !ok && !handled[k] {
			unknown = append(unknown, k)
		}
	}
	sort.Strings(unknown)
	for _, k := range unknown {
		c.add(k, vsxSkipped, k, "not a contribution Sulfur knows")
	}
	if pack := asList(c.m["extensionPack"]); len(pack) > 0 {
		var names []string
		for _, p := range pack {
			names = append(names, str(p))
		}
		c.add("extensionPack", vsxSkipped, plural(len(pack), "bundled extension"), "convert each on its own: "+strings.Join(names, ", "))
	}
}
