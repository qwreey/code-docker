package authgate

import (
	"net/http/httptest"
	"testing"
)

func TestClientKey(t *testing.T) {
	cases := []struct {
		remote, realIP, want string
	}{
		{"127.0.0.1:5555", "172.18.0.9", "172.18.0.9"},
		{"127.0.0.1:5555", "", "127.0.0.1"},
		{"127.0.0.1:5555", "not-an-ip", "127.0.0.1"},
		{"[::1]:5555", "172.20.0.2", "172.20.0.2"},
		{"172.18.0.9:5555", "1.2.3.4", "172.18.0.9"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", "/api/auth/unlock", nil)
		r.RemoteAddr = c.remote
		if c.realIP != "" {
			r.Header.Set("X-Real-IP", c.realIP)
		}
		if got := ClientKey(r); got != c.want {
			t.Errorf("ClientKey(remote=%s, X-Real-IP=%q) = %s, want %s", c.remote, c.realIP, got, c.want)
		}
	}
}
