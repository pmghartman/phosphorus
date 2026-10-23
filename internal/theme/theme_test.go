package theme

import (
	"strings"
	"testing"
)

func TestLibrary(t *testing.T) {
	l := Load()
	seen := map[string]bool{}
	for _, th := range l.Themes {
		if th.ID == "" || th.Label == "" || th.Look == "" || seen[th.ID] {
			t.Fatalf("theme %q: an id, label and look each, ids unique", th.ID)
		}
		seen[th.ID] = true
		for _, mode := range []string{"dark", "light", "oled"} {
			tk := l.Tokens(th.ID, mode)
			for _, k := range []string{"--bg", "--fg", "--accent", "--border", "--font", "--mono"} {
				if tk[k] == "" {
					t.Errorf("%s %s: no %s", th.ID, mode, k)
				}
			}
			if l.IDE(th.ID, mode)["--ide-bg"] == "" {
				t.Errorf("%s %s: no --ide-bg", th.ID, mode)
			}
		}
	}
	if !seen[Default] {
		t.Fatalf("no %s theme", Default)
	}
}

func TestLayers(t *testing.T) {
	l := Load()
	// light over the theme's dark, the base's light under the theme's own
	if got := l.Tokens("vscode", "light")["--bg"]; got != "#ffffff" {
		t.Errorf("vscode light bg %q", got)
	}
	if got := l.Tokens("vscode", "oled")["--bg"]; got != "#000000" {
		t.Errorf("vscode oled bg %q: the base's oled over its dark", got)
	}
	if got := l.Tokens("nope", "dark")["--bg"]; got != l.Tokens(Default, "dark")["--bg"] {
		t.Errorf("an unknown theme the default's, got %q", got)
	}
}

func TestLayout(t *testing.T) {
	l := Load()
	if got := l.Layout("macos"); got.BtnStyle != "lights" || got.Menubar != "top" || got.Bar != "bottom" || len(got.Items) == 0 {
		t.Errorf("macos layout %+v: its own over the base's", got)
	}
	if got := l.Layout(Default); got.BarStyle != "panel" || got.Btns != "right" {
		t.Errorf("default layout %+v", got)
	}
}

func TestCSS(t *testing.T) {
	css := Load().CSS()
	for _, want := range []string{
		`:root:where([data-palette="phosphorus"], :not([data-palette])) {`,
		`:root:where([data-palette="macos"][data-theme="light"]) {`,
		`:where(:root:where([data-palette="win11"][data-theme="oled"])) .ide-win {`,
		`:where(:root:where([data-palette="macos"])) .dk-app-code .dk-body {`,
	} {
		if !strings.Contains(css, want) {
			t.Errorf("css lacks %s", want)
		}
	}
}
