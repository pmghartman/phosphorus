package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// a fix the pinned tarball lacks, put in as it's unpacked: old must be in every file named,
// so a version that changed the code fails the build and the patch is looked at again
type patch struct {
	why   string
	files []string
	old   string
	new   string
}

var patches = map[string][]patch{
	"@lezer/lr": {{
		why: "two stacks of an ambiguous parse were cut to one once both passed 500 buffer entries, so " +
			"an object literal of 32+ shorthand properties followed by key: value was taken as a pattern " +
			"and reported as errors; ambiguity now resolved by the parse itself for far longer",
		files: []string{"dist/index.js", "dist/index.cjs"},
		old:   "stack.buffer.length > 500 /* Rec.MinBufferLengthPrune */ && other.buffer.length > 500 /* Rec.MinBufferLengthPrune */",
		new:   "stack.buffer.length > 20000 && other.buffer.length > 20000",
	}},
	"@lezer/go": {{
		why:   "true and false ending a line got no semicolon inserted (Go's rule inserts one after them), so x = true was an error",
		files: []string{"dist/index.js", "dist/index.cjs"},
		old:   "let trackedTokens = new Set([IncDecOp, identifier, Rune, String, Number,",
		new:   "let trackedTokens = new Set([IncDecOp, identifier, Rune, String, Number, 190 /* true, false */,",
	}, {
		why: "a /* comment */ before a line's end kept its semicolon from being inserted; the spec has a " +
			"comment without newlines act as a space, one with them as a newline",
		files: []string{"dist/index.js", "dist/index.cjs"},
		old:   "    if (next != space && next != tab) break\n",
		new: "    if (next == slash && input.peek(scan + 1) == 42) {\n" +
			"      let end = scan + 2, nl = false;\n" +
			"      for (let c; (c = input.peek(end)) >= 0 && !(c == 42 && input.peek(end + 1) == slash); end++) if (c == newline) nl = true;\n" +
			"      if (nl) { if (stack.context) input.acceptToken(insertedSemi); break }\n" +
			"      next = input.peek(scan = end + 2); continue\n" +
			"    }\n" +
			"    if (next != space && next != tab) break\n",
	}, {
		why: "a name starting with _ and a digit (_64bit) was read as a number with a digit separator " +
			"(Go's numbers never start with _), and for range n { … } (Go 1.22, no variables) was an " +
			"error whose recovery lost the loop's block: the grammar's tokens wrapped so the first is a " +
			"name, and the second read as for _ := range n through two tokens of no width",
		files: []string{"dist/index.js", "dist/index.cjs"},
		old:   "  tokenPrec: 5451\n});\n",
		new: "  tokenPrec: 5451\n});\n" +
			"let ghostAt = -1;\n" +
			"const isWordChar = (c) => c == 95 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c >= 0x80;\n" +
			"parser.tokenizers = parser.tokenizers.map((group) => typeof group.id != 'number' ? group /* a TokenGroup, minified names aside */ : {\n" +
			"  get contextual() { return ghostAt >= 0 }, fallback: false, extend: false,\n" +
			"  token(input, stack) {\n" +
			"    if (ghostAt >= 0 && input.pos != ghostAt) ghostAt = -1;\n" +
			"    if (input.next == 95 && input.peek(1) >= 48 && input.peek(1) <= 57) {\n" +
			"      let n = 1;\n" +
			"      while (isWordChar(input.peek(n))) n++;\n" +
			"      input.acceptToken(identifier, n);\n" +
			"      return;\n" +
			"    }\n" +
			"    if (ghostAt == input.pos && stack.canShift(100 /* := */)) { input.acceptToken(100, 0); return; }\n" +
			"    if (input.next == 114 && input.peek(1) == 97 && input.peek(2) == 110 && input.peek(3) == 103 && input.peek(4) == 101 &&\n" +
			"        !isWordChar(input.peek(5)) && !stack.canShift(133 /* range */) && stack.canShift(identifier)) {\n" +
			"      ghostAt = input.pos;\n" +
			"      input.acceptToken(identifier, 0);\n" +
			"      return;\n" +
			"    }\n" +
			"    group.token(input, stack);\n" +
			"  },\n" +
			"});\n",
	}},
	"@lezer/css": {{
		why:   "four-digit hex colors (#rgba) were errors",
		files: []string{"dist/index.js", "dist/index.cjs"},
		old:   `/^#[a-f\d]{3}([a-f\d]{3}([a-f\d]{2})?)?$/i`,
		new:   `/^#([a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i`,
	}},
}

// patchStamp what's kept beside an unpacked package: its integrity and the patches put in
func patchStamp(name, integrity string) string {
	ps := patches[name]
	if len(ps) == 0 {
		return integrity
	}
	h := sha256.New()
	for _, p := range ps {
		fmt.Fprintf(h, "%q %q %q\n", p.files, p.old, p.new)
	}
	return integrity + " patched " + hex.EncodeToString(h.Sum(nil)[:8])
}

func applyPatches(name, dir string) error {
	for _, p := range patches[name] {
		for _, f := range p.files {
			at := filepath.Join(dir, f)
			b, err := os.ReadFile(at)
			if err != nil {
				return err
			}
			if strings.Count(string(b), p.old) != 1 {
				return fmt.Errorf("%s/%s: the patch for %q no longer applies", name, f, p.why)
			}
			if err := os.WriteFile(at, []byte(strings.Replace(string(b), p.old, p.new, 1)), 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}
