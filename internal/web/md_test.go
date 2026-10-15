package web

import (
	"strings"
	"testing"
)

func TestMarkdown(t *testing.T) {
	h := Markdown("**hi** $x^2$ and `$y$`\n```go\nfunc main() {}\n```\n\n[a](javascript:x) [b](https://x.y) <script>alert(1)</script>", true)
	for _, want := range []string{"<strong>hi</strong>", `data-tex="x^2"`, "<code>$y$</code>", "hljs-keyword", `target="_blank"`} {
		if !strings.Contains(h, want) {
			t.Errorf("missing %q in %s", want, h)
		}
	}
	if strings.Contains(h, "<script") || strings.Contains(h, "javascript:") {
		t.Errorf("unsafe: %s", h)
	}
	if !strings.Contains(Markdown("- [x] done", true), `class="task"`) {
		t.Error("task")
	}
	if strings.Contains(Markdown("costs $5 and $6", true), "data-tex") {
		t.Error("prices as math")
	}
}

func TestBlocks(t *testing.T) {
	src := "# T\n\npara one\nstill\n\n```js\nx\n```\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
	bs := Blocks(src)
	joined := ""
	for _, b := range bs {
		joined += b.Raw
	}
	if joined != src {
		t.Fatalf("blocks don't cover the source: %q", joined)
	}
	if len(bs) != 5 {
		for _, b := range bs {
			t.Logf("%d %q", b.From, b.Raw)
		}
		t.Fatalf("want 5 blocks, got %d", len(bs))
	}
}
