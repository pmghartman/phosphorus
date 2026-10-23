// Package theme is phosphorus's theme library: every color, font, shadow and corner token of
// every theme, in themes.json, the one source the desktop, Sulfur, the terminals, the cli and
// the tray all draw from. The web build turns it into CSS (CSS); Go callers resolve a theme's
// tokens for a mode (Tokens).
package theme

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
)

//go:embed themes.json
var raw []byte

// Tokens a theme's custom properties ("--bg") and the odd plain property ("color-scheme")
type Tokens map[string]string

// Modes a set of tokens by light or dark: oled and light each lay over dark
type Modes struct {
	Dark  Tokens `json:"dark"`
	Light Tokens `json:"light"`
	Oled  Tokens `json:"oled"`
}

// Layout where the desktop's bars sit and how windows wear their chrome; empty fields the base's
type Layout struct {
	Bar      string   `json:"bar,omitempty"`      // bottom, top, left, right
	BarStyle string   `json:"barStyle,omitempty"` // panel, dock, full, line
	Menubar  string   `json:"menubar,omitempty"`  // off, top, bottom
	Items    []string `json:"items,omitempty"`    // status items shown, in order
	Btns     string   `json:"btns,omitempty"`     // left, right
	BtnStyle string   `json:"btnStyle,omitempty"` // glyphs, lights, caption
	Title    string   `json:"title,omitempty"`    // left, center
	Density  string   `json:"density,omitempty"`  // compact, normal, roomy
	Autohide string   `json:"autohide,omitempty"` // off, on: the bar tucked away until its edge is reached
	Labels   string   `json:"labels,omitempty"`   // both, icons, titles: what the bar's windows and the menu bar's app show
}

// Theme one entry: Look names the page's structural styles, Layout its bars and window chrome,
// Round and Sans mark rounded controls and a proportional page font, Scopes tokens for a part
// of the page alone
type Theme struct {
	ID     string           `json:"id"`
	Label  string           `json:"label"`
	About  string           `json:"about"`
	Look   string           `json:"look"`
	Layout Layout           `json:"layout"`
	Round  bool             `json:"round"`
	Sans   bool             `json:"sans"`
	Dark   Tokens           `json:"dark"`
	Light  Tokens           `json:"light"`
	Oled   Tokens           `json:"oled"`
	IDE    Modes            `json:"ide"`
	Scopes map[string]Modes `json:"scopes"`
}

// Library the whole file: the base every theme lays over, then the themes in their order
type Library struct {
	Base struct {
		Layout Layout `json:"layout"`
		Dark   Tokens `json:"dark"`
		Light  Tokens `json:"light"`
		Oled   Tokens `json:"oled"`
		IDE    Modes  `json:"ide"`
	} `json:"base"`
	Themes []Theme `json:"themes"`
}

// Default the theme a page or tool starts on
const Default = "phosphorus"

var (
	once sync.Once
	lib  Library
)

// Load the library, parsed once; themes.json failing to parse is a build mistake, so it panics
func Load() *Library {
	once.Do(func() {
		if err := json.Unmarshal(raw, &lib); err != nil {
			panic(fmt.Sprintf("theme: themes.json: %v", err))
		}
	})
	return &lib
}

// Get a theme by id, the default's for an unknown one
func (l *Library) Get(id string) *Theme {
	for i := range l.Themes {
		if l.Themes[i].ID == id {
			return &l.Themes[i]
		}
	}
	for i := range l.Themes {
		if l.Themes[i].ID == Default {
			return &l.Themes[i]
		}
	}
	return &l.Themes[0]
}

func merge(sets ...Tokens) Tokens {
	out := Tokens{}
	for _, s := range sets {
		for k, v := range s {
			out[k] = v
		}
	}
	return out
}

// Tokens a theme's page tokens for "dark", "light" or "oled": its dark over the base's, then
// for light or oled the base's and its own of that mode over those
func (l *Library) Tokens(id, mode string) Tokens {
	t := l.Get(id)
	switch mode {
	case "light":
		return merge(l.Base.Dark, t.Dark, l.Base.Light, t.Light)
	case "oled":
		return merge(l.Base.Dark, t.Dark, l.Base.Oled, t.Oled)
	}
	return merge(l.Base.Dark, t.Dark)
}

// IDE a theme's workbench tokens for a mode, laid over the base's as the page's are
func (l *Library) IDE(id, mode string) Tokens {
	t, b := l.Get(id), l.Base.IDE
	switch mode {
	case "light":
		return merge(b.Dark, b.Light, t.IDE.Dark, t.IDE.Light)
	case "oled":
		return merge(b.Dark, b.Oled, t.IDE.Dark, t.IDE.Oled)
	}
	return merge(b.Dark, t.IDE.Dark)
}

// Layout a theme's layout, its own fields over the base's
func (l *Library) Layout(id string) Layout {
	o, t := l.Base.Layout, l.Get(id).Layout
	pick := func(a *string, b string) {
		if b != "" {
			*a = b
		}
	}
	pick(&o.Bar, t.Bar)
	pick(&o.BarStyle, t.BarStyle)
	pick(&o.Menubar, t.Menubar)
	pick(&o.Btns, t.Btns)
	pick(&o.BtnStyle, t.BtnStyle)
	pick(&o.Title, t.Title)
	pick(&o.Density, t.Density)
	pick(&o.Autohide, t.Autohide)
	pick(&o.Labels, t.Labels)
	if t.Items != nil {
		o.Items = t.Items
	}
	return o
}

func scope(m Modes, mode string) Tokens {
	switch mode {
	case "light":
		return merge(m.Dark, m.Light)
	case "oled":
		return merge(m.Dark, m.Oled)
	}
	return m.Dark
}

func rule(b *strings.Builder, sel string, t Tokens) {
	if len(t) == 0 {
		return
	}
	keys := make([]string, 0, len(t))
	for k := range t {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	b.WriteString(sel)
	b.WriteString(" {")
	for _, k := range keys {
		fmt.Fprintf(b, " %s: %s;", k, t[k])
	}
	b.WriteString(" }\n")
}

// CSS every theme's tokens as rules: each theme's under its data-palette, light and oled by
// data-theme, all at a single class's weight (:where) so a custom theme's overrides win; the
// default's also when no theme is set yet
func (l *Library) CSS() string {
	var b strings.Builder
	b.WriteString("/* generated from internal/theme/themes.json by the web build */\n")
	for _, t := range l.Themes {
		for _, mode := range []string{"dark", "light", "oled"} {
			m := ""
			if mode != "dark" {
				m = fmt.Sprintf(`[data-theme="%s"]`, mode)
			}
			on := fmt.Sprintf(`[data-palette="%s"]%s`, t.ID, m)
			if t.ID == Default {
				on += `, :not([data-palette])` + m
			}
			rule(&b, ":root:where("+on+")", l.Tokens(t.ID, mode))
			rule(&b, ":where(:root:where("+on+")) .ide-win", l.IDE(t.ID, mode))
			sels := make([]string, 0, len(t.Scopes))
			for s := range t.Scopes {
				sels = append(sels, s)
			}
			sort.Strings(sels)
			for _, s := range sels {
				rule(&b, ":where(:root:where("+on+")) "+s, scope(t.Scopes[s], mode))
			}
		}
	}
	return b.String()
}
