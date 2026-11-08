package main

import (
	"io"
	"os"
	"strings"
	"testing"

	"webmanager/internal/authgate"
)

// runHashPassword feeds stdin to hashPasswordCmd (a pipe, so the non-terminal
// branch runs) and returns its exit code, stdout and stderr.
func runHashPassword(t *testing.T, stdin string) (code int, stdout, stderr string) {
	t.Helper()
	swap := func(f **os.File) (restore func(), r *os.File) {
		old := *f
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		*f = w
		return func() { w.Close(); *f = old }, r
	}
	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := inW.WriteString(stdin); err != nil {
		t.Fatal(err)
	}
	inW.Close()
	oldIn := os.Stdin
	os.Stdin = inR
	defer func() { os.Stdin = oldIn }()

	restoreOut, outR := swap(&os.Stdout)
	restoreErr, errR := swap(&os.Stderr)
	code = hashPasswordCmd()
	restoreOut()
	restoreErr()
	o, _ := io.ReadAll(outR)
	e, _ := io.ReadAll(errR)
	return code, string(o), string(e)
}

func TestHashPasswordRefusesShort(t *testing.T) {
	code, out, errOut := runHashPassword(t, "가나다라마바사아자차카\n")
	if code == 0 || out != "" || !strings.Contains(errOut, "at least 12") {
		t.Fatalf("11 characters: code=%d stdout=%q stderr=%q, want refusal", code, out, errOut)
	}
}

func TestHashPasswordAcceptsMinimum(t *testing.T) {
	code, out, errOut := runHashPassword(t, "가나다라마바사아자차카타\n")
	if code != 0 {
		t.Fatalf("12 characters: code=%d stderr=%q", code, errOut)
	}
	if ok, err := authgate.VerifyPassword("가나다라마바사아자차카타", strings.TrimSpace(out)); err != nil || !ok {
		t.Fatalf("printed hash doesn't verify: ok=%v err=%v", ok, err)
	}
}
