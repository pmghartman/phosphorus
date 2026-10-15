package collab

import (
	"encoding/json"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
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

// the same random op streams through collab.js's own transform
func TestTransformMatchesJS(t *testing.T) {
	src := ""
	for _, p := range []string{"../../legacy/frontend/collab.js", "../../frontend/collab.js"} {
		if _, err := os.Stat(p); err == nil {
			src, _ = filepath.Abs(p)
		}
	}
	if _, err := exec.LookPath("node"); err != nil || src == "" {
		t.Skip("no node or collab.js")
	}
	r := rand.New(rand.NewSource(7))
	type pair struct {
		Doc string `json:"doc"`
		A   []Op   `json:"a"`
		B   []Op   `json:"b"`
	}
	cases := []pair{}
	for i := 0; i < 2000; i++ {
		doc := []string{"", "hello world", "a😀b\nc", "line one\nline two\n"}[r.Intn(4)]
		u := U16(doc)
		cases = append(cases, pair{doc, randOp(r, len(u)), randOp(r, len(u))})
	}
	in, _ := json.Marshal(cases)
	js := `const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');` +
		`const ot=s.slice(s.indexOf('const isRetain'),s.indexOf('// --- sessions'));` +
		`const f=new Function(ot+';return {transform,apply};')();` +
		`const cs=JSON.parse(fs.readFileSync(0,'utf8'));` +
		`process.stdout.write(JSON.stringify(cs.map(c=>{const [a1,b1]=f.transform(c.a,c.b);return {a1,b1,t:f.apply(f.apply(c.doc,c.a),b1)}})))`
	cmd := exec.Command("node", "-e", js, src)
	stdin, _ := cmd.StdinPipe()
	go func() { stdin.Write(in); stdin.Close() }()
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var got []struct {
		A1, B1 json.RawMessage
		T      string
	}
	json.Unmarshal(out, &got)
	for i, c := range cases {
		a1, b1, _ := Transform(c.A, c.B)
		ja, _ := json.Marshal(a1)
		jb, _ := json.Marshal(b1)
		da, _ := Apply(U16(c.Doc), c.A)
		x, _ := Apply(da, b1)
		if string(ja) != string(got[i].A1) || string(jb) != string(got[i].B1) || Str(x) != got[i].T {
			t.Fatalf("case %d: go %s %s %q, js %s %s %q", i, ja, jb, Str(x), got[i].A1, got[i].B1, got[i].T)
		}
	}
}
