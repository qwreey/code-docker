package authgate

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A non-password unlock must never outlive the 12h window of the last typed
// password, and must never mint anything with no password unlock at all.
func TestIssueFromRespectsHardCap(t *testing.T) {
	g := New("configured-hash")
	if _, ok := g.IssueFrom(time.Time{}); ok {
		t.Error("IssueFrom(zero) minted a token")
	}
	if _, ok := g.IssueFrom(time.Now().Add(-maxSessionLifetime - time.Minute)); ok {
		t.Error("IssueFrom past the hard cap minted a token")
	}
	if _, ok := g.IssueFrom(time.Now().Add(time.Hour)); ok {
		t.Error("IssueFrom with a future origin minted a token")
	}
	if _, ok := New("").IssueFrom(time.Now().Add(-time.Hour)); ok {
		t.Error("an unconfigured gate minted a token")
	}

	origin := time.Now().Add(-time.Hour).Truncate(time.Second)
	token, ok := g.IssueFrom(origin)
	if !ok {
		t.Fatal("IssueFrom within the window refused")
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: token})
	got, _, ok := g.tokenTimes(r)
	if !ok || !got.Equal(origin) {
		t.Errorf("token origin = %v (ok=%v), want %v: the cap must count from the password", got, ok, origin)
	}
	if !g.Unlocked(r) {
		t.Error("a token from IssueFrom doesn't unlock")
	}
}
