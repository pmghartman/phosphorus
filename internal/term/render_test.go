package term

import "testing"

func TestRender(t *testing.T) {
	s := &session{cols: 20, rows: 5}
	s.chunks = [][]byte{[]byte("hello\r\n\x1b[31mred\x1b[0m wide 漢字\r\n")}
	for i := 0; i < 10; i++ {
		s.chunks = append(s.chunks, []byte("line\r\n"))
	}
	got := s.render()
	if got == "" || got[:5] != "hello" {
		t.Fatalf("%q", got)
	}
	t.Log(got)
}
