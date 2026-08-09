package tailscale

import "testing"

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
