import { expect, test } from "bun:test";
import { blocks, highlight, markdown } from "@phosphorus/web-md";

test("markdown", () => {
  const h = markdown(
    "**hi** $x^2$ and `$y$`\n```go\nfunc main() {}\n```\n\n[a](javascript:x) [b](https://x.y) <script>alert(1)</script>",
    true,
  );
  for (const want of ["<strong>hi</strong>", 'data-tex="x^2"', "<code>$y$</code>", "hljs-keyword", 'target="_blank"'])
    expect(h).toContain(want);
  expect(h).not.toContain("<script");
  expect(h).not.toContain("javascript:");
  expect(h).not.toContain("alert(1)");
  expect(markdown("- [x] done", true)).toContain('class="task"');
  expect(markdown("costs $5 and $6", true)).not.toContain("data-tex");
});

test("blocks", () => {
  const src = "# T\n\npara one\nstill\n\n```js\nx\n```\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  const bs = blocks(src);
  expect(bs.map((b) => b.raw).join("")).toBe(src);
  expect(bs.length).toBe(5);
  expect(bs.map((b) => b.from)).toEqual([0, 5, 21, 34, 43]);
  // leading blank lines belong to the first block
  expect(blocks("\n\nhi\n")[0]).toMatchObject({ from: 0, raw: "\n\nhi\n" });
  expect(blocks("  \n")).toEqual([]);
});

test("html as goldmark and bluemonday wrote it", () => {
  expect(markdown("a\nb", true)).toBe("<p>a<br>\nb</p>\n");
  expect(markdown("a\nb", false)).toBe("<p>a\nb</p>\n");
  expect(markdown("- [x] done\n- [ ] not", false)).toBe(
    '<ul>\n<li class="task"><input checked="" disabled="" type="checkbox"> done</li>\n<li class="task"><input disabled="" type="checkbox"> not</li>\n</ul>\n',
  );
  expect(markdown("```\nx < y\n```", false)).toBe('<pre><code class="hljs">x &lt; y\n</code></pre>\n');
  expect(markdown("$$a<b$$", false)).toBe(
    '<p><span class="math" data-tex="a&lt;b" data-display="1">a&lt;b</span></p>\n',
  );
  // a relative link to its text, an event handler gone
  expect(markdown('<a href="/rel" onclick="x()">r</a> x', false)).toBe("<p>r x</p>\n");
  expect(markdown("<details open><summary>s</summary>t</details>", false)).toBe(
    '<details open=""><summary>s</summary>t</details>',
  );
  expect(markdown('<img src=x onerror=alert(1)> <span title="t" style="color:red">s</span>', false)).toBe(
    '<p> <span title="t">s</span></p>\n',
  );
  expect(markdown("[m](mailto:a@b.c)", false)).toBe(
    '<p><a href="mailto:a@b.c" rel="noreferrer noopener" target="_blank">m</a></p>\n',
  );
  expect(markdown("| a | b |\n|:--|--:|\n| 1 | 2 |", false)).toContain('<th align="right">b</th>');
  expect(markdown("~~x~~ https://a.b/c", false)).toBe(
    '<p><s>x</s> <a href="https://a.b/c" rel="noreferrer noopener" target="_blank">https://a.b/c</a></p>\n',
  );
});

test("math spans", () => {
  expect(markdown("\\(a\\) and \\[b\\] and $c$", false)).toContain('data-tex="c"');
  expect(markdown("$a $", false)).not.toContain("data-tex");
  expect(markdown("$a$2", false)).not.toContain("data-tex");
  // code wins over math
  expect(markdown("`$a$` $b$", false)).toBe('<p><code>$a$</code> <span class="math" data-tex="b">b</span></p>\n');
});

test("highlight", () => {
  expect(highlight("x = 1", "")).toBe("x = 1");
  expect(highlight("<a>", "nosuchlang")).toBe("&lt;a&gt;");
  expect(highlight("let x = 1", "javascript")).toContain('<span class="hljs-keyword">let</span>');
  expect(highlight("def f(): pass", "py")).toContain("hljs-keyword");
});
