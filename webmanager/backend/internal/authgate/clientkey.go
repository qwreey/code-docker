package authgate

import (
	"net"
	"net/http"
)

// ClientKey identifies the caller for the lockout in TryUnlock and
// CheckAttempt. webmanager listens on loopback only, so every browser
// request arrives from the in-container nginx at 127.0.0.1 - keyed on the
// peer address alone, that was one bucket for everyone. nginx overwrites
// X-Real-IP on every location that proxies here, so from a loopback peer the
// header is nginx's word, not the client's. From any other peer (only
// possible with WEBMANAGER_ADDR moved off loopback) it is ignored, since
// there it would be client-controlled and a forgeable key lets an attacker
// reset their own lockout per request.
//
// What nginx's word is worth depends on ROUTER_CLIENT_IP_TOKEN (nginx's
// $code_docker_client_ip map): with it, the browser's address as router saw
// it; without it, nginx's own peer, which behind router is router's address
// for every browser - one bucket again, which is why the lockout's other
// paths (the WebDAV credential cache, the separate WebAuthn bucket) don't
// lean on this key to keep the owner in.
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
