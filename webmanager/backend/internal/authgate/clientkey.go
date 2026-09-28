package authgate

import (
	"net"
	"net/http"
)

// ClientKey identifies the caller for the lockout in TryUnlock and
// CheckAttempt. webmanager listens on loopback only, so every browser
// request arrives from the in-container nginx at 127.0.0.1 - keyed on the
// peer address alone, that was one bucket for everyone, and five wrong
// guesses from any container that can reach nginx locked the owner out too.
// nginx overwrites X-Real-IP with its own $remote_addr on every location that
// proxies here, so from a loopback peer the header is nginx's word, not the
// client's. From any other peer (only possible with WEBMANAGER_ADDR moved off
// loopback) it is ignored, since there it would be client-controlled and a
// forgeable key lets an attacker reset their own lockout per request.
func ClientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		if real := net.ParseIP(r.Header.Get("X-Real-IP")); real != nil {
			return real.String()
		}
	}
	return host
}
