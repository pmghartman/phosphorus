package minisign

import (
	"encoding/base64"
	"os"
	"testing"
)

func read(t *testing.T, n string) string {
	b, err := os.ReadFile("testdata/" + n)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// a key and signature made by rsign2, password hunter2
func TestReference(t *testing.T) {
	data := []byte(read(t, "data.bin"))
	pub, err := ParsePublicKey(base64.StdEncoding.EncodeToString([]byte(read(t, "e.pub"))))
	if err != nil {
		t.Fatal(err)
	}
	if err := pub.Verify(data, read(t, "data.e.sig")); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseSecretKey(read(t, "e.key"), "wrong"); err == nil {
		t.Fatal("wrong password opened the key")
	}
	sk, err := ParseSecretKey(base64.StdEncoding.EncodeToString([]byte(read(t, "e.key"))), "hunter2")
	if err != nil {
		t.Fatal(err)
	}
	sig := sk.Sign(data, "data.bin")
	if err := pub.Verify(data, sig); err != nil {
		t.Fatal(err)
	}
	if err := pub.Verify(append(data, 'x'), sig); err == nil {
		t.Fatal("tampered data verified")
	}
}
