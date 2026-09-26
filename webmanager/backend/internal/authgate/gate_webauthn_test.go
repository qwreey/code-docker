package authgate

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A non-password unlock must never run past passwordReauthInterval from the
// last typed password, and must never mint anything with no password
// unlock at all.
func TestIssueFromRespectsReauthInterval(t *testing.T) {
	g := New("configured-hash")
	if _, ok := g.IssueFrom(time.Time{}); ok {
		t.Error("IssueFrom(zero) minted a token")
	}
	if _, ok := g.IssueFrom(time.Now().Add(-passwordReauthInterval - time.Minute)); ok {
		t.Error("IssueFrom past the reauth interval minted a token")
	}
	if _, ok := g.IssueFrom(time.Now().Add(time.Hour)); ok {
		t.Error("IssueFrom with a future password time minted a token")
	}
	if _, ok := New("").IssueFrom(time.Now().Add(-time.Hour)); ok {
		t.Error("an unconfigured gate minted a token")
	}

	cookie := func(token string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.AddCookie(&http.Cookie{Name: CookieName, Value: token})
		return r
	}

	// Past maxSessionLifetime but inside the reauth interval: the point of
	// the split, a night's sleep no longer costs the fingerprint.
	token, ok := g.IssueFrom(time.Now().Add(-20 * time.Hour))
	if !ok {
		t.Fatal("IssueFrom 20h after the password refused")
	}
	if !g.Unlocked(cookie(token)) {
		t.Error("a token from IssueFrom doesn't unlock")
	}

	// Close to the deadline, the session's hard cap lands on it rather than
	// a full maxSessionLifetime later.
	passwordAt := time.Now().Add(-passwordReauthInterval + time.Hour)
	token, ok = g.IssueFrom(passwordAt)
	if !ok {
		t.Fatal("IssueFrom an hour before the deadline refused")
	}
	origin, _, ok := g.tokenTimes(cookie(token))
	if !ok {
		t.Fatal("token doesn't parse")
	}
	hard := origin.Add(maxSessionLifetime)
	if want := passwordAt.Add(passwordReauthInterval); hard.Sub(want) > time.Second || want.Sub(hard) > time.Second {
		t.Errorf("session hard cap = %v, want the reauth deadline %v", hard, want)
	}
}
