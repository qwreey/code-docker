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

func TestSetBandwidthRejectsNegativeTotal(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	_, err := SetBandwidth(path, Bandwidth{TotalMbps: -1})
	if err == nil {
		t.Fatalf("SetBandwidth(totalMbps=-1) = nil error, want validation error")
	}
}

func TestSetBandwidthRejectsZeroServiceLimit(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	_, err := SetBandwidth(path, Bandwidth{Services: []ServiceLimit{{TargetHost: "code-docker", LimitMbps: 0}}})
	if err == nil {
		t.Fatalf("SetBandwidth(limitMbps=0) = nil error, want validation error")
	}
}

func TestSetBandwidthRejectsDuplicateTargetHost(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	_, err := SetBandwidth(path, Bandwidth{Services: []ServiceLimit{
		{TargetHost: "code-docker", LimitMbps: 10},
		{TargetHost: "code-docker", LimitMbps: 20},
	}})
	if err == nil {
		t.Fatalf("SetBandwidth(duplicate target_host) = nil error, want validation error")
	}
}

func TestSetBandwidthAcceptsValidInput(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	bw, err := SetBandwidth(path, Bandwidth{
		TotalMbps: 100,
		Services:  []ServiceLimit{{TargetHost: "code-docker", LimitMbps: 50}, {TargetHost: "dind", LimitMbps: 50}},
	})
	if err != nil {
		t.Fatalf("SetBandwidth(valid) = %v, want success", err)
	}
	if bw.TotalMbps != 100 || len(bw.Services) != 2 {
		t.Fatalf("SetBandwidth() = %+v, want totalMbps=100 with 2 services", bw)
	}
	got, err := GetBandwidth(path)
	if err != nil {
		t.Fatalf("GetBandwidth() = %v, want success", err)
	}
	if got.TotalMbps != 100 || len(got.Services) != 2 {
		t.Fatalf("GetBandwidth() = %+v, want totalMbps=100 with 2 services", got)
	}
}

func TestGetBandwidthOnMissingFileReturnsEmptyNotNil(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	got, err := GetBandwidth(path)
	if err != nil {
		t.Fatalf("GetBandwidth(missing file) = %v, want success", err)
	}
	if got.Services == nil {
		t.Fatalf("GetBandwidth(missing file).Services = nil, want empty slice (JSON null crashes the frontend)")
	}
}
