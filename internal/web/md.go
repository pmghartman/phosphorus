// Package web: the page's static files and the chat's markdown, rendered
// here so the browser holds no markdown parser, sanitizer or highlighter
package web

import (
	"bytes"
	"crypto/sha256"
	"html"
	"regexp"
	"strings"
	"sync"

	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	ghtml "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// math: $$..$$ \[..\] display, \(..\) and $..$ inline, as the page had it
var mathRe = regexp.MustCompile(`\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(\S(?:\\\$|[^$\n])*?)\$`)
var codeRe = regexp.MustCompile("```[\\s\\S]*?(?:```|$)|`[^`\\n]+`")

// --- fenced code: chroma's tokens under highlight.js's class names --------

var hljsClass = []struct {
	t   chroma.TokenType
	cls string
}{
	{chroma.CommentPreproc, "hljs-meta"},
	{chroma.Comment, "hljs-comment"},
	{chroma.KeywordType, "hljs-type"},
	{chroma.KeywordConstant, "hljs-literal"},
	{chroma.Keyword, "hljs-keyword"},
	{chroma.NameBuiltin, "hljs-built_in"},
	{chroma.NameFunction, "hljs-title"},
	{chroma.NameClass, "hljs-title"},
	{chroma.NameTag, "hljs-tag"},
	{chroma.NameAttribute, "hljs-attr"},
	{chroma.NameDecorator, "hljs-meta"},
	{chroma.NameVariable, "hljs-variable"},
	{chroma.LiteralStringRegex, "hljs-regexp"},
	{chroma.LiteralString, "hljs-string"},
	{chroma.LiteralNumber, "hljs-number"},
	{chroma.GenericInserted, "hljs-addition"},
	{chroma.GenericDeleted, "hljs-deletion"},
	{chroma.GenericHeading, "hljs-section"},
	{chroma.GenericSubheading, "hljs-section"},
	{chroma.GenericEmph, "hljs-emphasis"},
	{chroma.GenericStrong, "hljs-strong"},
}

func classOf(t chroma.TokenType) string {
	for _, x := range []chroma.TokenType{t, t.SubCategory(), t.Category()} {
		for _, c := range hljsClass {
			if x == c.t {
				return c.cls
			}
		}
	}
	return ""
}

// Highlight code as highlight.js-classed spans, escaped text when unknown
func Highlight(code, lang string) string {
	l := lexers.Get(lang)
	if l == nil || lang == "" {
		return html.EscapeString(code)
	}
	it, err := chroma.Coalesce(l).Tokenise(nil, code)
	if err != nil {
		return html.EscapeString(code)
	}
	var b strings.Builder
	for _, tok := range it.Tokens() {
		c := classOf(tok.Type)
		if c == "" {
			b.WriteString(html.EscapeString(tok.Value))
			continue
		}
		b.WriteString(`<span class="` + c + `">`)
		b.WriteString(html.EscapeString(tok.Value))
		b.WriteString(`</span>`)
	}
	return b.String()
}

type codeRenderer struct{}

func (codeRenderer) RegisterFuncs(r renderer.NodeRendererFuncRegisterer) {
	r.Register(ast.KindFencedCodeBlock, func(w util.BufWriter, src []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		f := n.(*ast.FencedCodeBlock)
		lang := strings.ToLower(string(f.Language(src)))
		var body bytes.Buffer
		for i := 0; i < f.Lines().Len(); i++ {
			s := f.Lines().At(i)
			body.Write(s.Value(src))
		}
		cls := "hljs"
		if lang != "" {
			cls += " language-" + html.EscapeString(lang)
		}
		w.WriteString(`<pre><code class="` + cls + `">`)
		w.WriteString(Highlight(body.String(), lang))
		w.WriteString("</code></pre>\n")
		return ast.WalkContinue, nil
	})
}

func newMD(breaks bool) goldmark.Markdown {
	opts := []renderer.Option{ghtml.WithUnsafe(), renderer.WithNodeRenderers(util.Prioritized(codeRenderer{}, 100))}
	if breaks {
		opts = append(opts, ghtml.WithHardWraps())
	}
	return goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
		goldmark.WithRendererOptions(opts...),
	)
}

var (
	mdBreaks = newMD(true)
	mdPlain  = newMD(false)
	policy   = func() *bluemonday.Policy {
		p := bluemonday.NewPolicy()
		p.AllowElements("p", "br", "strong", "em", "del", "s", "code", "pre", "ul", "ol", "li", "blockquote", "hr",
			"h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td",
			"details", "summary", "kbd", "sup", "sub", "mark", "ins", "abbr", "span")
		p.AllowAttrs("href").OnElements("a")
		p.AllowURLSchemes("http", "https", "mailto")
		p.RequireNoReferrerOnLinks(true)
		p.AddTargetBlankToFullyQualifiedLinks(true)
		p.AllowAttrs("align").OnElements("th", "td")
		p.AllowAttrs("class").Globally()
		p.AllowAttrs("start").OnElements("ol")
		p.AllowAttrs("open").OnElements("details")
		p.AllowAttrs("title").Globally()
		p.AllowAttrs("colspan", "rowspan").OnElements("th", "td")
		p.AllowAttrs("data-tex", "data-display").OnElements("span")
		p.AllowElements("input")
		p.AllowAttrs("type").Matching(regexp.MustCompile(`^checkbox$`)).OnElements("input")
		p.AllowAttrs("checked", "disabled").OnElements("input")
		return p
	}()
)

var (
	cacheMu sync.Mutex
	cache   = map[[32]byte]string{}
)

// Markdown a line's text as sanitized html, math left as spans for katex
func Markdown(src string, breaks bool) string {
	key := sha256.Sum256([]byte(map[bool]string{true: "b", false: "p"}[breaks] + src))
	cacheMu.Lock()
	if h, ok := cache[key]; ok {
		cacheMu.Unlock()
		return h
	}
	cacheMu.Unlock()
	held := []string{}
	hold := func(h string) string {
		held = append(held, h)
		return "\x01" + itoa(len(held)-1) + "\x01"
	}
	code := []string{}
	t := codeRe.ReplaceAllStringFunc(src, func(m string) string {
		code = append(code, m)
		return "\x02" + itoa(len(code)-1) + "\x02"
	})
	t = replaceMath(t, func(tex string, display bool) string {
		d := ""
		if display {
			d = ` data-display="1"`
		}
		return hold(`<span class="math" data-tex="` + html.EscapeString(tex) + `"` + d + `>` + html.EscapeString(tex) + `</span>`)
	})
	t = regexp.MustCompile("\x02(\\d+)\x02").ReplaceAllStringFunc(t, func(m string) string { return code[atoi(m[1:len(m)-1])] })
	md := mdPlain
	if breaks {
		md = mdBreaks
	}
	var out bytes.Buffer
	if err := md.Convert([]byte(t), &out); err != nil {
		return html.EscapeString(src)
	}
	clean := policy.Sanitize(out.String())
	clean = regexp.MustCompile("\x01(\\d+)\x01").ReplaceAllStringFunc(clean, func(m string) string {
		return policy.Sanitize(held[atoi(m[1:len(m)-1])])
	})
	clean = tasks(clean)
	cacheMu.Lock()
	if len(cache) > 20000 {
		cache = map[[32]byte]string{}
	}
	cache[key] = clean
	cacheMu.Unlock()
	return clean
}

var taskRe = regexp.MustCompile(`<li>(<p>)?<input`)

// tasks a task's checkbox the only input, its li marked
func tasks(h string) string {
	h = taskRe.ReplaceAllString(h, `<li class="task">$1<input`)
	return strings.ReplaceAll(h, `<input checked="" disabled="" type="checkbox"`, `<input checked="" disabled="" type="checkbox"`)
}

// replaceMath JS's lookbehind-free equivalent of the page's MATH_RE: a
// single-$ span must not end on a space or be followed by a digit
func replaceMath(s string, fn func(tex string, display bool) string) string {
	var b strings.Builder
	last := 0
	for _, m := range mathRe.FindAllStringSubmatchIndex(s, -1) {
		if m[0] < last {
			continue
		}
		tex, display := "", true
		switch {
		case m[2] >= 0:
			tex = s[m[2]:m[3]]
		case m[4] >= 0:
			tex = s[m[4]:m[5]]
		case m[6] >= 0:
			tex, display = s[m[6]:m[7]], false
		default:
			tex, display = s[m[8]:m[9]], false
			if strings.HasSuffix(tex, " ") || strings.HasSuffix(tex, "\t") || (m[1] < len(s) && s[m[1]] >= '0' && s[m[1]] <= '9') {
				continue
			}
		}
		b.WriteString(s[last:m[0]])
		b.WriteString(fn(tex, display))
		last = m[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

// Block one top-level markdown block and where its source sits
type Block struct {
	From int    `json:"from"`
	Raw  string `json:"raw"`
	HTML string `json:"html"`
}

// Blocks a document's top-level blocks, each rendered, for the editor's view
func Blocks(src string) []Block {
	reader := text.NewReader([]byte(src))
	doc := mdPlain.Parser().Parse(reader)
	starts := []int{}
	for n := doc.FirstChild(); n != nil; n = n.NextSibling() {
		starts = append(starts, startOf(n, []byte(src)))
	}
	out := []Block{}
	for i, st := range starts {
		if st < 0 {
			continue
		}
		end := len(src)
		for j := i + 1; j < len(starts); j++ {
			if starts[j] >= 0 {
				end = starts[j]
				break
			}
		}
		if st > end {
			continue
		}
		raw := src[st:end]
		if strings.TrimSpace(raw) == "" {
			continue
		}
		out = append(out, Block{From: utf16Len(src[:st]), Raw: raw, HTML: Markdown(strings.TrimRight(raw, "\n"), false)})
	}
	if len(out) == 0 && strings.TrimSpace(src) != "" {
		out = append(out, Block{0, src, Markdown(src, false)})
	}
	if len(out) > 0 && out[0].From > 0 {
		out[0].Raw = src[:len(src)-len(src[byteAt(src, out[0].From):])] + out[0].Raw
		out[0].From = 0
	}
	return out
}

// startOf a block's first source byte, its line's start
func startOf(n ast.Node, src []byte) int {
	at := -1
	if f, ok := n.(*ast.FencedCodeBlock); ok {
		if f.Info != nil {
			at = f.Info.Segment.Start
		} else if f.Lines().Len() > 0 {
			at = f.Lines().At(0).Start - 1
			for at > 0 && src[at-1] != '\n' {
				at--
			}
			at--
		}
	} else if t, ok := n.(*ast.Text); ok {
		at = t.Segment.Start
	} else if n.Type() == ast.TypeBlock && n.Lines() != nil && n.Lines().Len() > 0 {
		at = n.Lines().At(0).Start
	} else {
		for c := n.FirstChild(); c != nil && at < 0; c = c.NextSibling() {
			at = startOf(c, src)
		}
	}
	if at < 0 {
		return -1
	}
	for at > 0 && src[at-1] != '\n' {
		at--
	}
	return at
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func byteAt(s string, u16 int) int {
	n := 0
	for i, r := range s {
		if n >= u16 {
			return i
		}
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return len(s)
}
