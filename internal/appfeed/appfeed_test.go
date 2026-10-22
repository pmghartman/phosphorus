package appfeed

import "testing"

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"0.8.1", "0.8.0", true}, {"0.8", "0.8.0", false}, {"0.10.0", "0.9.9", true}, {"0.7.9", "0.8", false}} {
		if Newer(c.a, c.b) != c.want {
			t.Errorf("Newer(%s, %s) != %v", c.a, c.b, c.want)
		}
	}
}
