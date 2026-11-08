package authgate

import (
	"errors"
	"testing"
	"time"
)

func TestVerifyPasswordBusyWhenSlotsTaken(t *testing.T) {
	hash, err := HashPassword("secret")
	if err != nil {
		t.Fatal(err)
	}
	old := verifyQueueWait
	verifyQueueWait = 50 * time.Millisecond
	t.Cleanup(func() { verifyQueueWait = old })

	for range maxConcurrentVerifies {
		verifySlots <- struct{}{}
	}
	_, err = VerifyPassword("secret", hash)
	for range maxConcurrentVerifies {
		<-verifySlots
	}
	if !errors.Is(err, ErrBusy) || !errors.Is(err, ErrRateLimited) {
		t.Fatalf("with every slot taken: err = %v, want ErrBusy wrapping ErrRateLimited", err)
	}

	ok, err := VerifyPassword("secret", hash)
	if err != nil || !ok {
		t.Fatalf("with slots free again: ok=%v err=%v, want a match", ok, err)
	}
}

func TestCheckNewPasswordCountsCodePoints(t *testing.T) {
	for _, c := range []struct {
		name string
		pw   string
		ok   bool
	}{
		{"empty", "", false},
		{"11 ascii", "abcdefghijk", false},
		{"12 ascii", "abcdefghijkl", true},
		// 11 Hangul syllables are 33 bytes: a byte count would let it through.
		{"11 multi-byte", "가나다라마바사아자차카", false},
		{"12 multi-byte", "가나다라마바사아자차카타", true},
		// An emoji is one code point however many bytes it takes.
		{"11 with emoji", "abcdefghij😀", false},
		{"12 with emoji", "abcdefghijk😀", true},
	} {
		err := CheckNewPassword(c.pw)
		if (err == nil) != c.ok {
			t.Errorf("%s: CheckNewPassword(%q) = %v, want ok=%v", c.name, c.pw, err, c.ok)
		}
		if err != nil && !errors.Is(err, ErrPasswordTooShort) {
			t.Errorf("%s: err = %v, want ErrPasswordTooShort", c.name, err)
		}
	}
}

// Hashes made under the old policy are short; what the gate must do is notice
// once the plaintext is seen, and forget it when the hash is replaced.
func TestGateWeakPasswordFlag(t *testing.T) {
	short, err := HashPassword("short-pw")
	if err != nil {
		t.Fatal(err)
	}
	long, err := HashPassword("long-enough-passphrase")
	if err != nil {
		t.Fatal(err)
	}

	g := New(short)
	if g.WeakPassword() {
		t.Fatal("weak before any password was typed: unknown must read as not weak")
	}
	if _, ok, _ := g.TryUnlock("k", "wrong-guess"); ok || g.WeakPassword() {
		t.Fatalf("a wrong guess set the flag (ok=%v weak=%v)", ok, g.WeakPassword())
	}
	if _, ok, err := g.TryUnlock("k", "short-pw"); !ok || err != nil {
		t.Fatalf("correct password: ok=%v err=%v", ok, err)
	}
	if !g.WeakPassword() {
		t.Fatal("a successful unlock with a short password did not set the flag")
	}

	// Replacing the hash means a new Gate, which starts clean.
	g2 := New(long)
	if _, ok, _ := g2.TryUnlock("k", "long-enough-passphrase"); !ok {
		t.Fatal("long password rejected")
	}
	if g2.WeakPassword() {
		t.Fatal("a 22-character password was flagged weak")
	}

	var unset *Gate
	if unset.WeakPassword() || New("").WeakPassword() {
		t.Fatal("nil or unconfigured gate reported weak")
	}
}
