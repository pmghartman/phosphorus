package util

import (
	"math/rand"
	"testing"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

func TestLocaleCompareMatchesICU(t *testing.T) {
	ref := collate.New(language.Und)
	alpha := []rune(" !\"#$%&'()*+,-./0123456789:;<=>?@AZ[\\]^_`az{|}~éÉüñçÅ")
	rng := rand.New(rand.NewSource(1))
	bad := 0
	for i := 0; i < 200000; i++ {
		mk := func() string {
			n := rng.Intn(6) + 1
			r := make([]rune, n)
			for j := range r {
				r[j] = alpha[rng.Intn(len(alpha))]
			}
			return string(r)
		}
		a, b := mk(), mk()
		want := ref.CompareString(a, b)
		if want == 0 {
			want = map[bool]int{true: -1, false: 1}[a < b]
			if a == b {
				want = 0
			}
		}
		if got := LocaleCompare(a, b); got != want {
			bad++
			if bad < 15 {
				t.Errorf("%q vs %q: got %d want %d", a, b, got, want)
			}
		}
	}
	if bad > 0 {
		t.Errorf("%d mismatches", bad)
	}
}
