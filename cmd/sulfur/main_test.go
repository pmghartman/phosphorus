package main

import "testing"

func TestServerURL(t *testing.T) {
	for in, want := range map[string]string{
		"d6":                       "http://d6",
		"100.64.0.7":               "http://100.64.0.7",
		"d6:8080":                  "http://d6:8080",
		"d6.tail1234.ts.net":       "http://d6.tail1234.ts.net",
		"mulab.dev":                "https://mulab.dev",
		"https://mulab.dev/":       "https://mulab.dev",
		"http://mulab.dev":         "http://mulab.dev",
		"  https://mulab.dev/x?y ": "https://mulab.dev",
	} {
		u, err := serverURL(in)
		if err != nil || u.String() != want {
			t.Errorf("%q: %v %v, want %s", in, u, err, want)
		}
	}
	for _, bad := range []string{"", "ftp://x", "https://"} {
		if _, err := serverURL(bad); err == nil {
			t.Errorf("%q taken", bad)
		}
	}
}

func TestLocalCookie(t *testing.T) {
	got := localCookie("sid=abc; Path=/; Domain=.mulab.dev; Secure; HttpOnly; SameSite=None")
	if got != "sid=abc; Path=/; HttpOnly; SameSite=Lax" {
		t.Fatal(got)
	}
}
