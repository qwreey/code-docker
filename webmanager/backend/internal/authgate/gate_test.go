package authgate

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// requestWithToken builds a request carrying an unlock cookie whose session
// started at origin and was last refreshed at refreshed.
func requestWithToken(g *Gate, origin, refreshed time.Time) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/anything", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: g.mintToken(origin, refreshed)})
	return r
}

// legacyToken is the single-timestamp payload minted by builds from before
// sliding expiry existed.
func legacyToken(g *Gate, issued time.Time) string {
	payload := strconv.FormatInt(issued.Unix(), 10)
	sig := g.sign([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func TestUnlockedHonorsIdleAndLifetime(t *testing.T) {
	g := New("dummy-hash")
	now := time.Now()

	cases := []struct {
		name              string
		origin, refreshed time.Time
		want              bool
	}{
		{"fresh", now, now, true},
		{"refreshed recently, long-running session", now.Add(-11 * time.Hour), now.Add(-time.Minute), true},
		{"idle past sessionTTL", now.Add(-time.Hour), now.Add(-sessionTTL - time.Minute), false},
		{"past maxSessionLifetime despite refresh", now.Add(-maxSessionLifetime - time.Minute), now, false},
		{"refreshed before it was issued", now.Add(-time.Minute), now.Add(-time.Hour), false},
		{"issued in the future", now.Add(time.Hour), now.Add(time.Hour), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := g.Unlocked(requestWithToken(g, tc.origin, tc.refreshed)); got != tc.want {
				t.Fatalf("Unlocked = %v, want %v", got, tc.want)
			}
		})
	}
}

// A token minted by an older build carries one timestamp and no ":" — it
// must keep working across an upgrade rather than forcing a re-login.
func TestLegacyTokenStillAccepted(t *testing.T) {
	g := New("dummy-hash")
	r := httptest.NewRequest(http.MethodGet, "/api/anything", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: legacyToken(g, time.Now().Add(-time.Minute))})
	if !g.Unlocked(r) {
		t.Fatal("a legacy single-timestamp token should still unlock")
	}
}

func TestTamperedTokenRejected(t *testing.T) {
	g := New("dummy-hash")
	r := requestWithToken(g, time.Now(), time.Now())
	c, _ := r.Cookie(CookieName)
	// Re-sign is impossible without the secret; flipping the payload alone
	// must fail the HMAC check.
	r2 := httptest.NewRequest(http.MethodGet, "/api/anything", nil)
	r2.AddCookie(&http.Cookie{Name: CookieName, Value: "x" + c.Value})
	if g.Unlocked(r2) {
		t.Fatal("a tampered token must not unlock")
	}
}

// RequirePassword must slide the deadline forward once refreshThreshold has
// passed — that's what keeps an actively-used tab from being logged out on
// the absolute schedule it used to follow.
func TestRequirePasswordSlidesExpiry(t *testing.T) {
	g := New("dummy-hash")
	origin := time.Now().Add(-time.Hour)
	stale := time.Now().Add(-refreshThreshold - time.Minute)

	rec := httptest.NewRecorder()
	var served bool
	g.RequirePassword(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { served = true })).
		ServeHTTP(rec, requestWithToken(g, origin, stale))
	if !served {
		t.Fatal("a valid token should have passed through")
	}

	var refreshed *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == CookieName {
			refreshed = c
		}
	}
	if refreshed == nil {
		t.Fatal("expected a refreshed unlock cookie")
	}

	// The refreshed cookie must be good for a full sessionTTL again, while
	// still reporting the original session start (so maxSessionLifetime
	// keeps counting from the password the user actually typed).
	next := httptest.NewRequest(http.MethodGet, "/api/anything", nil)
	next.AddCookie(refreshed)
	until, ok := g.UnlockedUntil(next)
	if !ok {
		t.Fatal("refreshed cookie should be unlocked")
	}
	if remaining := time.Until(until); remaining < sessionTTL-time.Minute {
		t.Fatalf("refreshed cookie only good for %v, want ~%v", remaining, sessionTTL)
	}
	gotOrigin, _, ok := g.tokenTimes(next)
	if !ok || gotOrigin.Unix() != origin.Unix() {
		t.Fatalf("refresh moved the session origin: got %v, want %v", gotOrigin, origin)
	}
}

// Below refreshThreshold there's deliberately no Set-Cookie, so a fast poll
// loop doesn't carry one on every single response.
func TestRequirePasswordSkipsRefreshWhenFresh(t *testing.T) {
	g := New("dummy-hash")
	now := time.Now()
	rec := httptest.NewRecorder()
	g.RequirePassword(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).
		ServeHTTP(rec, requestWithToken(g, now, now))
	for _, c := range rec.Result().Cookies() {
		if c.Name == CookieName {
			t.Fatal("a just-refreshed token should not be re-issued")
		}
	}
}

// The cap is what stops a tab that polls a gated endpoint from holding an
// unlock open forever.
func TestRefreshCannotOutliveMaxSessionLifetime(t *testing.T) {
	g := New("dummy-hash")
	origin := time.Now().Add(-maxSessionLifetime).Add(time.Minute)
	r := requestWithToken(g, origin, time.Now())
	until, ok := g.UnlockedUntil(r)
	if !ok {
		t.Fatal("session should still be unlocked one minute before the cap")
	}
	if remaining := time.Until(until); remaining > 2*time.Minute {
		t.Fatalf("expiry %v ignores maxSessionLifetime", remaining)
	}
}
