package users

import (
	"encoding/hex"
	"os/exec"
	"strings"
	"testing"

	"github.com/pmghartman/phosphorus/internal/util"
)

// vectors recorded from Node's crypto (scrypt defaults, aes-256-gcm)
const (
	vecSalt = "00112233445566778899aabbccddeeff"
	vecPass = "hunter2 ünï"
	vecOut  = "8c86694dfb3f9a13c8f4068192ad0ddaf52fe9bbcd03d2a578ed68ca0fc79eb37579bc061fc2e5c5209ea0c8099bec46821efcfd5231b68850c6af01ec7f0a04"
	vecText = `{"hosts":{},"pages":{}} ✓`
)

var vecBox = Box{IV: "0102030405060708090a0b0c", Tag: "d94ae642cf96f284c42501cd55dbf86f", Data: "tG5xYqWZD7fplRlMOuSspjXD2htU2GVVnEm9"}

func TestDeriveMatchesNode(t *testing.T) {
	if got := hex.EncodeToString(Derive(vecPass, vecSalt)); got != vecOut {
		t.Fatalf("scrypt: got %s", got)
	}
}

func TestOpenNodeBox(t *testing.T) {
	out, _ := hex.DecodeString(vecOut)
	text, ok := Open(out[32:], vecBox)
	if !ok || text != vecText {
		t.Fatalf("open: %q %v", text, ok)
	}
	if _, ok := Open(out[:32], vecBox); ok {
		t.Fatal("opened with the wrong key")
	}
}

func TestSealRoundTrip(t *testing.T) {
	out, _ := hex.DecodeString(vecOut)
	b := Seal(out[32:], vecText)
	if text, ok := Open(out[32:], b); !ok || text != vecText {
		t.Fatal("round trip")
	}
}

func TestB64URL(t *testing.T) {
	b, err := B64URL("eyJhIjoiw6k_PiJ9")
	if err != nil || string(b) != `{"a":"é?>"}` {
		t.Fatalf("%s %v", b, err)
	}
}

// Node opening Go's box, when node is on the path
func TestNodeOpensGoBox(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node")
	}
	out, _ := hex.DecodeString(vecOut)
	b := Seal(out[32:], vecText)
	js := `const c=require("crypto");const b=JSON.parse(process.argv[1]);const k=Buffer.from(process.argv[2],"hex");` +
		`const d=c.createDecipheriv("aes-256-gcm",k,Buffer.from(b.iv,"hex"));d.setAuthTag(Buffer.from(b.tag,"hex"));` +
		`process.stdout.write(Buffer.concat([d.update(Buffer.from(b.data,"base64")),d.final()]).toString("utf8"))`
	got, err := exec.Command("node", "-e", js, string(util.Marshal(b)), hex.EncodeToString(out[32:])).Output()
	if err != nil || strings.TrimSpace(string(got)) != vecText {
		t.Fatalf("node: %q %v", got, err)
	}
}
