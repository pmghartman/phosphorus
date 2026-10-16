package util

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// ICU root's order of ASCII's spaces, punctuation and symbols, all before digits
const rootPunct = "\t\n\v\f\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"

var asciiRank = func() (r [128]int32) {
	for i := range r {
		r[i] = -1
	}
	for i, c := range rootPunct {
		r[c] = int32(i + 1)
	}
	for c := '0'; c <= '9'; c++ {
		r[c] = int32(100 + c - '0')
	}
	for c := 'a'; c <= 'z'; c++ {
		r[c], r[c-32] = int32(200+c-'a'), int32(200+c-'a')
	}
	return
}()

// rootRank a base character's primary weight, -1 when ignorable
func rootRank(c rune) int32 {
	switch {
	case c < 128:
		return asciiRank[c]
	case unicode.IsControl(c):
		return -1
	case unicode.IsSpace(c):
		return 0
	case unicode.IsDigit(c):
		return 100 + int32(unicode.ToLower(c)%10)
	case unicode.IsLetter(c):
		return 1000 + unicode.ToLower(c)
	}
	return 50
}

type rootKey struct {
	prim  []int32
	marks []string
	upper []bool
}

func rootKeyOf(s string) rootKey {
	var k rootKey
	for _, c := range norm.NFD.String(s) {
		if unicode.Is(unicode.Mn, c) {
			if n := len(k.marks); n > 0 {
				k.marks[n-1] += string(c)
			}
			continue
		}
		w := rootRank(c)
		if w < 0 {
			continue
		}
		k.prim = append(k.prim, w)
		k.marks = append(k.marks, "")
		k.upper = append(k.upper, unicode.IsUpper(c))
	}
	return k
}

func cmpSlice[T any](a, b []T, less func(x, y T) int) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if c := less(a[i], b[i]); c != 0 {
			return c
		}
	}
	return len(a) - len(b)
}

// LocaleCompare as String.prototype.localeCompare under ICU's root order:
// base letters, then accents, then lower before upper, then bytes
func LocaleCompare(a, b string) int {
	ka, kb := rootKeyOf(a), rootKeyOf(b)
	c := cmpSlice(ka.prim, kb.prim, func(x, y int32) int { return int(x - y) })
	if c == 0 {
		c = cmpSlice(ka.marks, kb.marks, strings.Compare)
	}
	if c == 0 {
		c = cmpSlice(ka.upper, kb.upper, func(x, y bool) int {
			switch {
			case x == y:
				return 0
			case x:
				return 1
			}
			return -1
		})
	}
	if c == 0 {
		c = strings.Compare(a, b)
	}
	switch {
	case c < 0:
		return -1
	case c > 0:
		return 1
	}
	return 0
}
