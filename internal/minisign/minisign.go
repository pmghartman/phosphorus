// Package minisign: the update feed's signatures, minisign's format as the
// installed apps already trust it; keys and signatures as base64 of their files
package minisign

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/scrypt"
)

var (
	algLegacy = []byte("Ed")
	algHashed = []byte("ED")
	kdfScrypt = []byte("Sc")
	chkBlake  = []byte("B2")
)

// PublicKey a key id and its ed25519 half
type PublicKey struct {
	ID  [8]byte
	Key ed25519.PublicKey
}

// SecretKey a key id and its ed25519 private half
type SecretKey struct {
	ID  [8]byte
	Key ed25519.PrivateKey
}

// unwrap a file's base64 line: given as the file itself, base64 of the file, or the line alone
func unwrap(s string, line int) ([]byte, []string, error) {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "untrusted comment:") {
		if b, err := base64.StdEncoding.DecodeString(s); err == nil && bytes.HasPrefix(b, []byte("untrusted comment:")) {
			s = string(b)
		}
	}
	lines := strings.Split(strings.ReplaceAll(strings.TrimSpace(s), "\r\n", "\n"), "\n")
	if !strings.HasPrefix(lines[0], "untrusted comment:") {
		lines = append([]string{"untrusted comment:"}, lines...)
	}
	if len(lines) <= line {
		return nil, nil, errors.New("minisign: truncated")
	}
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(lines[line]))
	return b, lines, err
}

// ParsePublicKey a public key file, base64 of one, or its key line
func ParsePublicKey(s string) (*PublicKey, error) {
	b, _, err := unwrap(s, 1)
	if err != nil {
		return nil, err
	}
	if len(b) != 42 || !bytes.Equal(b[:2], algLegacy) {
		return nil, errors.New("minisign: not an ed25519 public key")
	}
	k := &PublicKey{Key: ed25519.PublicKey(b[10:])}
	copy(k.ID[:], b[2:10])
	return k, nil
}

// ParseSecretKey a secret key file or base64 of one, opened with password when encrypted
func ParseSecretKey(s, password string) (*SecretKey, error) {
	b, _, err := unwrap(s, 1)
	if err != nil {
		return nil, err
	}
	if len(b) != 158 || !bytes.Equal(b[:2], algLegacy) || !bytes.Equal(b[4:6], chkBlake) {
		return nil, errors.New("minisign: not an ed25519 secret key")
	}
	salt, ops, mem := b[6:38], binary.LittleEndian.Uint64(b[38:46]), binary.LittleEndian.Uint64(b[46:54])
	body := append([]byte(nil), b[54:]...)
	switch {
	case bytes.Equal(b[2:4], kdfScrypt):
		n, r, p := scryptParams(ops, mem)
		stream, err := scrypt.Key([]byte(password), salt, 1<<n, r, p, len(body))
		if err != nil {
			return nil, err
		}
		for i := range body {
			body[i] ^= stream[i]
		}
	case b[2] != 0 || b[3] != 0:
		return nil, errors.New("minisign: unknown key derivation")
	}
	h, _ := blake2b.New256(nil)
	h.Write(b[:2])
	h.Write(body[:72])
	if !bytes.Equal(h.Sum(nil), body[72:104]) {
		return nil, errors.New("minisign: wrong password or damaged key")
	}
	k := &SecretKey{Key: ed25519.PrivateKey(body[8:72])}
	copy(k.ID[:], body[:8])
	return k, nil
}

// scryptParams libsodium's choice of n (as log2), r and p from its ops and memory limits
func scryptParams(ops, mem uint64) (n, r, p int) {
	if ops < 32768 {
		ops = 32768
	}
	r = 8
	pick := func(maxN uint64) int {
		n := 1
		for ; n < 63; n++ {
			if uint64(1)<<n > maxN/2 {
				break
			}
		}
		return n
	}
	if ops < mem/32 {
		return pick(ops / uint64(r*4)), r, 1
	}
	n = pick(mem / uint64(r*128))
	maxrp := (ops / 4) / (uint64(1) << n)
	if maxrp > 0x3fffffff {
		maxrp = 0x3fffffff
	}
	return n, r, int(maxrp) / r
}

// Sign data prehashed, its trusted comment the time and file name; base64 of the signature file
func (k *SecretKey) Sign(data []byte, file string) string {
	sum := blake2b.Sum512(data)
	sig := ed25519.Sign(k.Key, sum[:])
	trusted := fmt.Sprintf("timestamp:%d\tfile:%s", time.Now().Unix(), file)
	global := ed25519.Sign(k.Key, append(append([]byte(nil), sig...), trusted...))
	line := append(append(append([]byte(nil), algHashed...), k.ID[:]...), sig...)
	text := "untrusted comment: signature from phosphorus secret key\n" + base64.StdEncoding.EncodeToString(line) +
		"\ntrusted comment: " + trusted + "\n" + base64.StdEncoding.EncodeToString(global) + "\n"
	return base64.StdEncoding.EncodeToString([]byte(text))
}

// Verify data against a signature file, base64 of one, by this key
func (k *PublicKey) Verify(data []byte, sig string) error {
	b, lines, err := unwrap(sig, 1)
	if err != nil {
		return err
	}
	if len(b) != 74 || len(lines) < 4 {
		return errors.New("minisign: malformed signature")
	}
	if !bytes.Equal(b[2:10], k.ID[:]) {
		return errors.New("minisign: signed by another key")
	}
	msg := data
	switch {
	case bytes.Equal(b[:2], algHashed):
		sum := blake2b.Sum512(data)
		msg = sum[:]
	case !bytes.Equal(b[:2], algLegacy):
		return errors.New("minisign: unknown signature algorithm")
	}
	if !ed25519.Verify(k.Key, msg, b[10:]) {
		return errors.New("minisign: bad signature")
	}
	trusted, ok := strings.CutPrefix(lines[2], "trusted comment: ")
	global, err := base64.StdEncoding.DecodeString(strings.TrimSpace(lines[3]))
	if !ok || err != nil || !ed25519.Verify(k.Key, append(append([]byte(nil), b[10:]...), trusted...), global) {
		return errors.New("minisign: bad trusted comment")
	}
	return nil
}
