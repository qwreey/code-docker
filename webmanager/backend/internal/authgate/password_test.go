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
