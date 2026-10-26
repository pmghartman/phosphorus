package proxy

import "testing"

func TestReverseLocation(t *testing.T) {
	const prefix, host, svc = "/torus/sunshine", "mulab.dev", "100.105.120.33:47990"
	for _, c := range []struct {
		loc, want string
	}{
		{"/welcome", "/torus/sunshine/welcome"},
		{"/", "/torus/sunshine/"},
		{"/apps?x=1#top", "/torus/sunshine/apps?x=1#top"},
		{"/a%2Fb", "/torus/sunshine/a%2Fb"},
		{"https://mulab.dev/welcome", "https://mulab.dev/torus/sunshine/welcome"},
		{"https://MULAB.dev", "https://MULAB.dev/torus/sunshine/"},
		{"https://100.105.120.33:47990/pin", "https://100.105.120.33:47990/torus/sunshine/pin"},
		// already under the prefix, relative, or elsewhere: as they are
		{"/torus/sunshine/welcome", "/torus/sunshine/welcome"},
		{"/torus/sunshine", "/torus/sunshine"},
		{"/torus/sunshinex", "/torus/sunshine/torus/sunshinex"},
		{"welcome", "welcome"},
		{"./welcome", "./welcome"},
		{"?q=1", "?q=1"},
		{"//evil.example/x", "//evil.example/x"},
		{"https://accounts.example/login", "https://accounts.example/login"},
		{"mailto:a@b", "mailto:a@b"},
	} {
		if got := reverseLocation(c.loc, prefix, host, svc); got != c.want {
			t.Errorf("reverseLocation(%q) = %q, want %q", c.loc, got, c.want)
		}
	}
	if got := reverseLocation("/welcome", "", host); got != "/welcome" {
		t.Errorf("no prefix: %q", got)
	}
}
