package netgate

import "testing"

func TestAddForwardRejectsInvalidTargetHost(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	_, err := AddForward(path, Forward{HostPort: 8080, TargetHost: "10.0.0.1,evil", TargetPort: 80})
	if err == nil {
		t.Fatalf("AddForward(targetHost with comma) = nil error, want validation error")
	}
}

func TestAddForwardRejectsOutOfRangePort(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	_, err := AddForward(path, Forward{HostPort: 0, TargetHost: "10.0.0.1", TargetPort: 80})
	if err == nil {
		t.Fatalf("AddForward(hostPort=0) = nil error, want validation error")
	}
}

func TestAddForwardAcceptsValidInput(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	f, err := AddForward(path, Forward{HostPort: 8080, TargetHost: "code-docker", TargetPort: 80})
	if err != nil {
		t.Fatalf("AddForward(valid) = %v, want success", err)
	}
	if f.TargetHost != "code-docker" {
		t.Fatalf("AddForward() = %+v, want targetHost=code-docker", f)
	}
}
