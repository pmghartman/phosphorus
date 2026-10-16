package collab

import (
	"math/rand"
	"testing"
)

func randOp(r *rand.Rand, n int) []Op {
	var b builder
	left := n
	for left > 0 || r.Intn(4) == 0 {
		switch k := r.Intn(3); {
		case k == 0:
			ins := []rune{}
			for i := 0; i <= r.Intn(4); i++ {
				ins = append(ins, []rune("ab\n😀é")[r.Intn(5)])
			}
			b.insert(U16(string(ins)))
		case left > 0 && k == 1:
			d := 1 + r.Intn(left)
			b.del(d)
			left -= d
		case left > 0:
			d := 1 + r.Intn(left)
			b.retain(d)
			left -= d
		}
		if left == 0 && r.Intn(2) == 0 {
			break
		}
	}
	if b.ops == nil {
		return []Op{}
	}
	return b.ops
}

func TestTransformConverges(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for i := 0; i < 5000; i++ {
		doc := U16([]string{"", "hello world", "a😀b\nc", "line one\nline two\n"}[r.Intn(4)])
		a, b := randOp(r, len(doc)), randOp(r, len(doc))
		a1, b1, err := Transform(a, b)
		if err != nil {
			t.Fatal(err)
		}
		da, _ := Apply(doc, a)
		db, _ := Apply(doc, b)
		x, err1 := Apply(da, b1)
		y, err2 := Apply(db, a1)
		if err1 != nil || err2 != nil || Str(x) != Str(y) {
			t.Fatalf("diverged: %q %q", Str(x), Str(y))
		}
	}
}
