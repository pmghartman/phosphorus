package cli

import (
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// --- the web's look ----------------------------------------------------------

type palette map[string]string

var dark = palette{
	"bg": "#141414", "fg": "#e0e0e0", "muted": "#9d9d9d", "accent": "#9f81cf", "accent2": "#ce8755", "dim": "#555555",
	"glyphPurple": "#a371f7", "glyphOrange": "#f0883e", "border": "#2e2e2e", "card": "#1b1b1b", "tabbar": "#0c0c0c",
	"online": "#3fb950", "offmesh": "#f85149", "warn": "#d29922",
	"teal": "#6fb3a8", "sage": "#93ad7d", "sky": "#7fa0c9", "rose": "#c98ba0", "sand": "#c4ab78",
}

var light = func() palette {
	p := palette{}
	for k, v := range dark {
		p[k] = v
	}
	for k, v := range map[string]string{"bg": "#ffffff", "fg": "#1f1f23", "muted": "#6b6b73", "dim": "#b4b4bb", "border": "#e4e4e7", "card": "#f4f4f5", "tabbar": "#f7f7f8",
		"accent": "#6a4bb0", "accent2": "#a65a1e", "glyphPurple": "#7c4ddb", "glyphOrange": "#c4621a",
		"online": "#1a7f37", "offmesh": "#cf222e", "warn": "#9a6700",
		"teal": "#2f7f72", "sage": "#577a3c", "sky": "#3d6a9e", "rose": "#a8506f", "sand": "#8a6a2c"} {
		p[k] = v
	}
	return p
}()

var (
	pal       = dark
	truecolor = regexp.MustCompile(`(?i)truecolor|24bit`).MatchString(os.Getenv("COLORTERM")) ||
		map[string]bool{"iTerm.app": true, "WezTerm": true, "vscode": true, "ghostty": true, "Hyper": true, "Tabby": true}[os.Getenv("TERM_PROGRAM")]
	base string
	off  string
)

const page = "\x1b[49m"

func rgb(hex string) [3]float64 {
	var out [3]float64
	for i := 0; i < 3; i++ {
		v, _ := strconv.ParseInt(hex[1+2*i:3+2*i], 16, 0)
		out[i] = float64(v)
	}
	return out
}

func hexOf(c [3]float64) string {
	return fmt.Sprintf("#%02x%02x%02x", int(math.Round(c[0])), int(math.Round(c[1])), int(math.Round(c[2])))
}

func mix(a, b string, t float64) string {
	x, y := rgb(a), rgb(b)
	var out [3]float64
	for i := range out {
		out[i] = x[i] + (y[i]-x[i])*t
	}
	return hexOf(out)
}

var levels = []float64{0, 95, 135, 175, 215, 255}

func to256(v [3]float64) int {
	idx := [3]int{}
	for i, x := range v {
		switch {
		case x < 48:
			idx[i] = 0
		case x < 115:
			idx[i] = 1
		default:
			idx[i] = int(math.Floor((x - 35) / 40))
		}
	}
	g := int(math.Max(0, math.Min(23, math.Round((v[0]+v[1]+v[2])/3/10-0.8))))
	dist := func(w [3]float64) float64 {
		n := 0.0
		for i, x := range w {
			n += (x - v[i]) * (x - v[i])
		}
		return n
	}
	grey := float64(8 + 10*g)
	if dist([3]float64{grey, grey, grey}) < dist([3]float64{levels[idx[0]], levels[idx[1]], levels[idx[2]]}) {
		return 232 + g
	}
	return 16 + 36*idx[0] + 6*idx[1] + idx[2]
}

func color(layer int, h string) string {
	c := rgb(h)
	if truecolor {
		return fmt.Sprintf("\x1b[%d;2;%d;%d;%dm", layer, int(c[0]), int(c[1]), int(c[2]))
	}
	return fmt.Sprintf("\x1b[%d;5;%dm", layer, to256(c))
}

func fg(h string) string { return color(38, h) }
func bg(h string) string { return color(48, h) }

// c one helper per token, back to the page's fg after
func c(token string) func(string) string {
	return func(s string) string { return fg(pal[token]) + s + fg(pal["fg"]) }
}

func setTheme(isLight bool) {
	if isLight {
		pal = light
	} else {
		pal = dark
	}
	base = "\x1b[0m" + page + fg(pal["fg"])
	off = mix(pal["muted"], pal["border"], 0.45)
}

func bold(s string) string   { return "\x1b[1m" + s + "\x1b[22m" }
func strike(s string) string { return "\x1b[9m" + s + "\x1b[29m" }

// surface a span on its own background, then the page's again
func surface(bgHex string, fgHex ...string) func(string) string {
	f := pal["fg"]
	if len(fgHex) > 0 {
		f = fgHex[0]
	}
	return func(s string) string {
		b := bg(bgHex)
		if bgHex == pal["bg"] {
			b = page
		}
		return b + fg(f) + s + page + fg(pal["fg"])
	}
}

func caret() string { return surface(pal["accent"])(" ") }

// shift the bands' offset now: the web glyph's 6s ease out and back
func shift() float64 {
	t := float64(time.Now().UnixMilli()%6000) / 3000
	if t > 1 {
		t = 2 - t
	}
	return t * t * (3 - 2*t)
}

func gradient(s string, span int) string {
	chars := []rune(s)
	if span == 0 {
		span = len(chars)
	}
	off := shift()
	var b strings.Builder
	for i, ch := range chars {
		t := off
		if span > 1 {
			t += float64(i) / float64(span-1)
		}
		t -= math.Floor(t)
		u := t * 2
		if t >= 0.5 {
			u = (1 - t) * 2
		}
		b.WriteString(fg(mix(pal["glyphPurple"], pal["glyphOrange"], u)))
		b.WriteRune(ch)
	}
	b.WriteString(fg(pal["fg"]))
	return b.String()
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)

func vlen(s string) int { return len([]rune(ansiRe.ReplaceAllString(s, ""))) }

func pad(s string, w int) string {
	if n := w - vlen(s); n > 0 {
		return s + strings.Repeat(" ", n)
	}
	return s
}

// splitKeep s split around re's matches, the matches kept
func splitKeep(re *regexp.Regexp, s string) []string {
	out := []string{}
	last := 0
	for _, m := range re.FindAllStringIndex(s, -1) {
		out = append(out, s[last:m[0]], s[m[0]:m[1]])
		last = m[1]
	}
	return append(out, s[last:])
}

func cut(s string, w int) string {
	var b strings.Builder
	n := 0
	for _, part := range splitKeep(ansiRe, s) {
		if strings.HasPrefix(part, "\x1b[") {
			b.WriteString(part)
			continue
		}
		r := []rune(part)
		take := w - n
		if take < 0 {
			take = 0
		}
		if take > len(r) {
			take = len(r)
		}
		b.WriteString(string(r[:take]))
		n += take
	}
	return b.String()
}

func fit(s string, w int) string { return cut(s, w) + base }

var wrapTok = regexp.MustCompile(`(\x1b\[[0-9;?]*[A-Za-z]| +)`)

func wrap(s string, w, hang int) []string {
	if vlen(s) <= w || w < 2 {
		return []string{s}
	}
	out := []string{}
	codes, line := "", ""
	n, room := 0, w
	next := func() {
		out = append(out, line)
		line = strings.Repeat(" ", hang) + codes
		n = 0
		room = w - hang
		if room < 1 {
			room = 1
		}
	}
	for _, tok := range splitKeep(wrapTok, s) {
		if tok == "" {
			continue
		}
		if strings.HasPrefix(tok, "\x1b[") {
			codes += tok
			line += tok
			continue
		}
		chars := []rune(tok)
		if tok[0] == ' ' {
			if n+len(chars) <= room {
				line += tok
				n += len(chars)
			} else if n > 0 {
				next()
			}
			continue
		}
		if n+len(chars) > room && n > 0 {
			next()
		}
		for i := 0; i < len(chars); i += room {
			if i > 0 {
				next()
			}
			end := i + room
			if end > len(chars) {
				end = len(chars)
			}
			line += string(chars[i:end])
			n += end - i
		}
	}
	return append(out, line)
}

func inner() int {
	cols, _ := size()
	if cols-5 < 20 {
		return 20
	}
	return cols - 5
}

// row one line of a view, a selected row drawn on the hover surface
type row struct {
	text string
	sel  bool
}

func plainRows(ls ...string) []row {
	out := make([]row, len(ls))
	for i, l := range ls {
		out[i] = row{text: l}
	}
	return out
}

func table(headers []string, rows [][]string, sel, max int) []row {
	w := make([]int, len(headers))
	for i, h := range headers {
		w[i] = vlen(h)
		for _, r := range rows {
			if i < len(r) && vlen(r[i]) > w[i] {
				w[i] = vlen(r[i])
			}
		}
	}
	mark := sel >= 0
	room := inner() - 2*(len(w)-1)
	if mark {
		room -= 2
	}
	sum := 0
	for _, x := range w {
		sum += x
	}
	for over := sum - room; over > 0; over-- {
		mi := 0
		for i, x := range w {
			if x > w[mi] {
				mi = i
			}
		}
		if w[mi] <= 4 {
			break
		}
		w[mi]--
	}
	lines := func(cells []string, on bool) []string {
		parts := make([][]string, len(w))
		most := 1
		for i := range w {
			cell := ""
			if i < len(cells) {
				cell = cells[i]
			}
			parts[i] = wrap(cell, w[i], 0)
			if len(parts[i]) > most {
				most = len(parts[i])
			}
		}
		out := []string{}
		for k := 0; k < most; k++ {
			lead := ""
			if mark {
				if on && k == 0 {
					lead = c("accent")("›") + " "
				} else {
					lead = "  "
				}
			}
			cs := []string{}
			for i, p := range parts {
				x := ""
				if k < len(p) {
					x = p[k]
				}
				cs = append(cs, pad(x, w[i]))
			}
			out = append(out, lead+strings.Join(cs, "  "))
		}
		return out
	}
	shown := len(rows)
	if max > 0 && len(rows) > max {
		shown = max - 1
		if shown < 1 {
			shown = 1
		}
	}
	from := sel - shown/2
	if from > len(rows)-shown {
		from = len(rows) - shown
	}
	if from < 0 {
		from = 0
	}
	out := []row{}
	for i := from; i < from+shown && i < len(rows); i++ {
		on := i == sel
		for _, l := range lines(rows[i], on) {
			out = append(out, row{l, on})
		}
	}
	if shown < len(rows) {
		lead := ""
		if mark {
			lead = "  "
		}
		out = append(out, row{text: c("muted")(fmt.Sprintf("%s%d-%d of %d", lead, from+1, from+shown, len(rows)))})
	}
	head := []string{}
	for i, h := range headers {
		head = append(head, pad(cut(h, w[i]), w[i]))
	}
	lead := ""
	if mark {
		lead = "  "
	}
	return append([]row{{text: c("sage")(lead + strings.Join(head, "  "))}}, out...)
}

func panel(title string, lines []row, w int) []string {
	b := c("border")
	head := cut(title, w-1)
	top := b("┌" + strings.Repeat("─", w+2) + "┐")
	if title != "" {
		top = b("┌─") + " " + c("sage")(head) + " " + b(strings.Repeat("─", max0(w-vlen(head)-1))+"┐")
	}
	out := []string{top}
	for _, l := range lines {
		if l.sel {
			out = append(out, b("│")+surface(pal["border"])(" "+pad(l.text, w)+" ")+b("│"))
			continue
		}
		for _, x := range wrap(l.text, w, 0) {
			out = append(out, b("│")+" "+pad(x, w)+" "+b("│"))
		}
	}
	return append(out, b("└"+strings.Repeat("─", w+2)+"┘"))
}

func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

type card struct {
	title string
	lines []row
}

func panels(list ...*card) []string {
	items := []*card{}
	for _, x := range list {
		if x != nil {
			items = append(items, x)
		}
	}
	// the width of the window, as the frontend's cards
	w := inner()
	out := []string{}
	for i, it := range items {
		if i > 0 {
			out = append(out, "")
		}
		out = append(out, panel(it.title, it.lines, w)...)
	}
	return out
}

// key one of a view's buttons: label and kind
type key struct{ label, kind string }
