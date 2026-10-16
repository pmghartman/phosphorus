// Package collab: shared code and text, one live session per file, edits as
// text operations rebased in arrival order. Positions count UTF-16
// units, as the browsers' strings do
package collab

import (
	"encoding/json"
	"errors"
	"math"
	"unicode/utf16"
)

// Op a retain (N > 0), a delete (N < 0) or an insert (S non-nil)
type Op struct {
	N int
	S []uint16
}

func (o Op) isInsert() bool { return o.S != nil }
func (o Op) isRetain() bool { return o.S == nil && o.N > 0 }
func (o Op) isDelete() bool { return o.S == nil && o.N < 0 }

// MarshalJSON a number or a string
func (o Op) MarshalJSON() ([]byte, error) {
	if o.S != nil {
		return json.Marshal(string(utf16.Decode(o.S)))
	}
	return json.Marshal(o.N)
}

// U16 a string as UTF-16 units
func U16(s string) []uint16 { return utf16.Encode([]rune(s)) }

// Str UTF-16 units back to a string
func Str(u []uint16) string { return string(utf16.Decode(u)) }

type builder struct{ ops []Op }

func (b *builder) add(o Op) {
	if (o.S == nil && o.N == 0) || (o.S != nil && len(o.S) == 0) {
		return
	}
	n := len(b.ops)
	if n > 0 {
		last := b.ops[n-1]
		if o.isInsert() && last.isDelete() {
			if n >= 2 && b.ops[n-2].isInsert() {
				b.ops[n-2].S = append(append([]uint16{}, b.ops[n-2].S...), o.S...)
			} else {
				b.ops = append(b.ops[:n-1], o, last)
			}
			return
		}
		if o.isInsert() && last.isInsert() {
			b.ops[n-1].S = append(append([]uint16{}, last.S...), o.S...)
			return
		}
		if !o.isInsert() && !last.isInsert() && (o.N > 0) == (last.N > 0) {
			b.ops[n-1].N += o.N
			return
		}
	}
	b.ops = append(b.ops, o)
}
func (b *builder) retain(n int)      { b.add(Op{N: n}) }
func (b *builder) insert(s []uint16) { b.add(Op{S: s}) }
func (b *builder) del(n int)         { b.add(Op{N: -n}) }

func baseLength(ops []Op) int {
	n := 0
	for _, o := range ops {
		if !o.isInsert() {
			if o.N < 0 {
				n -= o.N
			} else {
				n += o.N
			}
		}
	}
	return n
}

// Parse ops from JSON, false when not valid
func Parse(raw any) ([]Op, bool) {
	arr, ok := raw.([]any)
	if !ok || len(arr) > 10000 {
		return nil, false
	}
	out := make([]Op, 0, len(arr))
	for _, x := range arr {
		switch v := x.(type) {
		case string:
			if v == "" {
				return nil, false
			}
			out = append(out, Op{S: U16(v)})
		case float64:
			if v == 0 || v != math.Trunc(v) || math.Abs(v) > 9007199254740991 {
				return nil, false
			}
			out = append(out, Op{N: int(v)})
		default:
			return nil, false
		}
	}
	return out, true
}

// Apply ops to doc
func Apply(doc []uint16, ops []Op) ([]uint16, error) {
	if baseLength(ops) != len(doc) {
		return nil, errors.New("operation does not fit the text")
	}
	out := make([]uint16, 0, len(doc))
	at := 0
	for _, o := range ops {
		switch {
		case o.isInsert():
			out = append(out, o.S...)
		case o.N > 0:
			out = append(out, doc[at:at+o.N]...)
			at += o.N
		default:
			at -= o.N
		}
	}
	return out, nil
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// Transform a and b from the same text: a' after b and b' after a
func Transform(a, b []Op) ([]Op, []Op, error) {
	var a1, b1 builder
	i, j := 0, 0
	next := func(ops []Op, k *int) *Op {
		if *k >= len(ops) {
			*k++
			return nil
		}
		o := ops[*k]
		*k++
		return &o
	}
	x := next(a, &i)
	y := next(b, &j)
	for {
		if x == nil && y == nil {
			break
		}
		if x != nil && x.isInsert() {
			a1.insert(x.S)
			b1.retain(len(x.S))
			x = next(a, &i)
			continue
		}
		if y != nil && y.isInsert() {
			a1.retain(len(y.S))
			b1.insert(y.S)
			y = next(b, &j)
			continue
		}
		if x == nil || y == nil {
			return nil, nil, errors.New("operations of different lengths")
		}
		n := abs(x.N)
		if abs(y.N) < n {
			n = abs(y.N)
		}
		switch {
		case x.isRetain() && y.isRetain():
			a1.retain(n)
			b1.retain(n)
		case x.isDelete() && y.isRetain():
			a1.del(n)
		case x.isRetain() && y.isDelete():
			b1.del(n)
		}
		if abs(x.N) == n {
			x = next(a, &i)
		} else if x.N > 0 {
			x = &Op{N: x.N - n}
		} else {
			x = &Op{N: x.N + n}
		}
		if abs(y.N) == n {
			y = next(b, &j)
		} else if y.N > 0 {
			y = &Op{N: y.N - n}
		} else {
			y = &Op{N: y.N + n}
		}
	}
	return nonNil(a1.ops), nonNil(b1.ops), nil
}

// MapPos where a place in the text lands after an edit
func MapPos(ops []Op, pos int) int {
	i, j := 0, 0
	for _, o := range ops {
		if o.isInsert() {
			j += len(o.S)
			continue
		}
		n := abs(o.N)
		if pos <= i+n {
			if o.N > 0 {
				return j + (pos - i)
			}
			return j
		}
		i += n
		if o.N > 0 {
			j += n
		}
	}
	return j
}

func nonNil(ops []Op) []Op {
	if ops == nil {
		return []Op{}
	}
	return ops
}
