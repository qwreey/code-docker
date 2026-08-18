package tailscale

import (
	"os"
	"testing"
)

// TestAddForwardRejectsCommaInRemoteHost guards against a real socat
// address-injection risk: tailscale-forward.default.sh splices remote_host
// unquoted-field-wise into `SOCKS5:"$socks5":"$remote_host":"$remote_port"`,
// and socat parses a comma inside that field as an additional address
// option rather than a literal hostname character.
func TestAddForwardRejectsCommaInRemoteHost(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	_, err := AddForward(path, Forward{
		Name:       "evil",
		LocalPort:  8080,
		RemoteHost: "example.com,reuseaddr,fork",
		RemotePort: 22,
	})
	if err == nil {
		t.Fatalf("AddForward(remoteHost with comma) = nil error, want validation error")
	}
}

func TestAddForwardRejectsOutOfRangePort(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	_, err := AddForward(path, Forward{
		Name:       "bad-port",
		LocalPort:  70000,
		RemoteHost: "example.com",
		RemotePort: 22,
	})
	if err == nil {
		t.Fatalf("AddForward(localPort=70000) = nil error, want validation error")
	}
}

func TestAddForwardAcceptsValidInput(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	f, err := AddForward(path, Forward{
		Name:       "ok",
		LocalPort:  8080,
		RemoteHost: "example.com",
		RemotePort: 22,
	})
	if err != nil {
		t.Fatalf("AddForward(valid) = %v, want success", err)
	}
	if f.Name != "ok" {
		t.Fatalf("AddForward() = %+v, want name=ok", f)
	}
}

func TestAddPublishRejectsColonInTargetHost(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	_, err := AddPublish(path, Publish{
		Name:          "evil",
		TailscalePort: 443,
		TargetHost:    "example.com:8080",
		LocalPort:     8080,
	})
	if err == nil {
		t.Fatalf("AddPublish(targetHost with colon) = nil error, want validation error")
	}
}

// TestAddPublishRejectsSelfHost guards against a real SSRF/exposure risk:
// tailscale-publish.default.sh does `tailscale serve --bg ... "tcp://$thost:$lport"`,
// so a TargetHost of "127.0.0.1" or "router" would expose router's own
// loopback-bound services (e.g. an internal admin port) to the entire
// tailnet.
func TestAddPublishRejectsSelfHost(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "router", "localhost", "::1", "forward"} {
		path := t.TempDir() + "/config.yaml"
		_, err := AddPublish(path, Publish{
			Name:          "evil",
			TailscalePort: 443,
			TargetHost:    host,
			LocalPort:     8080,
		})
		if err == nil {
			t.Fatalf("AddPublish(targetHost=%q) = nil error, want rejection", host)
		}
	}
}

// TestAddForwardRejectsSelfHost guards the RemoteHost side of the same
// issue: tailscaled's own SOCKS5 proxy runs inside router, so a
// RemoteHost of "127.0.0.1"/"router" would have it connect back to
// router's own loopback, exposing it to code-docker-internal via the
// forward's local_port.
func TestAddForwardRejectsSelfHost(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "router", "localhost", "::1", "forward"} {
		path := t.TempDir() + "/config.yaml"
		_, err := AddForward(path, Forward{
			Name:       "evil",
			LocalPort:  8080,
			RemoteHost: host,
			RemotePort: 22,
		})
		if err == nil {
			t.Fatalf("AddForward(remoteHost=%q) = nil error, want rejection", host)
		}
	}
}

func TestSetGlobalConfigRejectsMalformedSocksAddress(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	if err := SetGlobalConfig(path, GlobalConfig{SocksAddress: "localhost,1055"}); err == nil {
		t.Fatalf("SetGlobalConfig(malformed socksAddress) = nil error, want validation error")
	}
	if err := SetGlobalConfig(path, GlobalConfig{SocksAddress: "localhost:1055"}); err != nil {
		t.Fatalf("SetGlobalConfig(valid socksAddress) = %v, want success", err)
	}
}

// TestSetGlobalConfigLoginServer covers the UI-set login server field: empty
// must stay valid (identical to today's unset-env behavior - loading the
// Tailscale tab must never itself make this "set"), a plain http(s) URL must
// round-trip, and anything else must be rejected as a validation error
// rather than being handed straight to `tailscale up --login-server=`.
func TestSetGlobalConfigLoginServer(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	if err := SetGlobalConfig(path, GlobalConfig{SocksAddress: "localhost:1055", LoginServer: ""}); err != nil {
		t.Fatalf("SetGlobalConfig(loginServer=\"\") = %v, want success", err)
	}
	if got, err := GetGlobalConfig(path); err != nil || got.LoginServer != "" {
		t.Fatalf("GetGlobalConfig() = %+v, %v, want empty loginServer", got, err)
	}

	if err := SetGlobalConfig(path, GlobalConfig{SocksAddress: "localhost:1055", LoginServer: "not-a-url"}); err == nil {
		t.Fatalf("SetGlobalConfig(loginServer=not-a-url) = nil error, want validation error")
	}

	if err := SetGlobalConfig(path, GlobalConfig{SocksAddress: "localhost:1055", LoginServer: "https://tail.example.com"}); err != nil {
		t.Fatalf("SetGlobalConfig(valid loginServer) = %v, want success", err)
	}
	if got, err := GetGlobalConfig(path); err != nil || got.LoginServer != "https://tail.example.com" {
		t.Fatalf("GetGlobalConfig() = %+v, %v, want loginServer=https://tail.example.com", got, err)
	}
}

// TestEffectiveLoginServerEnvWins guards the core priority requirement: a
// real TAILSCALE_LOGIN_SERVER env var must always win over whatever is
// persisted via the Tailscale tab, exactly like ROUTER_MANAGER_AUTH_PASSWORD_HASH/
// TINYAUTH_AUTH_USERS already do for their own UI-vs-env fields.
func TestEffectiveLoginServerEnvWins(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	if err := SetGlobalConfig(path, GlobalConfig{SocksAddress: "localhost:1055", LoginServer: "https://ui-set.example.com"}); err != nil {
		t.Fatalf("SetGlobalConfig() = %v, want success", err)
	}

	if got, err := EffectiveLoginServer(path); err != nil || got != "https://ui-set.example.com" {
		t.Fatalf("EffectiveLoginServer() (no env) = %q, %v, want ui-set value", got, err)
	}
	if LoginServerPinned() {
		t.Fatalf("LoginServerPinned() = true with no env set, want false")
	}

	t.Setenv("TAILSCALE_LOGIN_SERVER", "https://env-pinned.example.com")
	if got, err := EffectiveLoginServer(path); err != nil || got != "https://env-pinned.example.com" {
		t.Fatalf("EffectiveLoginServer() (env set) = %q, %v, want env value to win", got, err)
	}
	if !LoginServerPinned() {
		t.Fatalf("LoginServerPinned() = false with env set, want true")
	}
}

// TestEffectiveLoginServerDefaultsEmpty guards the "don't touch/apply the
// default unless the user actually picks one" requirement: with neither the
// env var nor a UI value set, EffectiveLoginServer must resolve to "" (which
// callers translate to "use tailscale.com's own SaaS"), never any other
// default.
func TestEffectiveLoginServerDefaultsEmpty(t *testing.T) {
	path := t.TempDir() + "/config.yaml" // never seeded - mirrors a fresh install
	os.Unsetenv("TAILSCALE_LOGIN_SERVER")
	got, err := EffectiveLoginServer(path)
	if err != nil {
		t.Fatalf("EffectiveLoginServer() error = %v", err)
	}
	if got != "" {
		t.Fatalf("EffectiveLoginServer() = %q, want empty (no default)", got)
	}
}
