package main

import "testing"

func testConfig() *config {
	return &config{
		AllowedCaps:       map[string]bool{"NET_BIND_SERVICE": true},
		BindAllowPrefixes: []string{"/code/"},
	}
}

func TestEvaluate(t *testing.T) {
	cases := []struct {
		name  string
		body  string
		allow bool
	}{
		{"plain container, no HostConfig fields", `{}`, true},
		{"privileged denied", `{"HostConfig":{"Privileged":true}}`, false},
		{"allowed cap passes", `{"HostConfig":{"CapAdd":["NET_BIND_SERVICE"]}}`, true},
		{"allowed cap with CAP_ prefix passes", `{"HostConfig":{"CapAdd":["CAP_NET_BIND_SERVICE"]}}`, true},
		{"disallowed cap denied", `{"HostConfig":{"CapAdd":["SYS_ADMIN"]}}`, false},
		{"CapAdd ALL denied (not in allow-list)", `{"HostConfig":{"CapAdd":["ALL"]}}`, false},
		{"seccomp unconfined denied", `{"HostConfig":{"SecurityOpt":["seccomp=unconfined"]}}`, false},
		{"apparmor unconfined denied", `{"HostConfig":{"SecurityOpt":["apparmor=unconfined"]}}`, false},
		{"unrelated security-opt passes", `{"HostConfig":{"SecurityOpt":["no-new-privileges"]}}`, true},
		{"pid host denied", `{"HostConfig":{"PidMode":"host"}}`, false},
		{"network host denied", `{"HostConfig":{"NetworkMode":"host"}}`, false},
		{"network bridge passes", `{"HostConfig":{"NetworkMode":"bridge"}}`, true},
		{"ipc host denied", `{"HostConfig":{"IpcMode":"host"}}`, false},
		{"cgroupns host denied", `{"HostConfig":{"CgroupnsMode":"host"}}`, false},
		{"device passthrough denied", `{"HostConfig":{"Devices":[{"PathOnHost":"/dev/mem"}]}}`, false},
		{"device cgroup rule denied", `{"HostConfig":{"DeviceCgroupRules":["a *:* rwm"]}}`, false},
		{"bind under /code allowed", `{"HostConfig":{"Binds":["/code/myproject/pgdata:/var/lib/postgresql/data"]}}`, true},
		{"bind of /code root itself allowed", `{"HostConfig":{"Binds":["/code:/mnt"]}}`, true},
		{"bind outside /code denied", `{"HostConfig":{"Binds":["/etc:/mnt/etc"]}}`, false},
		{"bind of sibling-prefixed dir denied", `{"HostConfig":{"Binds":["/codesecrets:/mnt"]}}`, false},
		{"bind of docker.sock denied", `{"HostConfig":{"Binds":["/var/run/docker.sock:/var/run/docker.sock"]}}`, false},
		{"bind of authz config dir denied", `{"HostConfig":{"Binds":["/etc/dind-authz.d:/foo"]}}`, false},
		{"named volume allowed", `{"HostConfig":{"Binds":["mydata:/var/lib/postgresql/data"]}}`, true},
		{"mount type bind under /code allowed", `{"HostConfig":{"Mounts":[{"Type":"bind","Source":"/code/x"}]}}`, true},
		{"mount type bind outside /code denied", `{"HostConfig":{"Mounts":[{"Type":"bind","Source":"/root"}]}}`, false},
		{"mount type volume ignored by bind check", `{"HostConfig":{"Mounts":[{"Type":"volume","Source":"mydata"}]}}`, true},
		{"malformed json fails open (daemon validates)", `not json`, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			allow, reason := evaluate([]byte(tc.body), testConfig())
			if allow != tc.allow {
				t.Errorf("evaluate(%s) = allow=%v reason=%q, want allow=%v", tc.body, allow, reason, tc.allow)
			}
			if !allow && reason == "" {
				t.Errorf("evaluate(%s) denied with no reason", tc.body)
			}
		})
	}
}

func TestIsContainersCreate(t *testing.T) {
	cases := []struct {
		method, uri string
		want        bool
	}{
		{"POST", "/v1.43/containers/create", true},
		{"POST", "/v1.43/containers/create?name=foo", true},
		{"POST", "/containers/create", true},
		{"GET", "/v1.43/containers/create", false},
		{"POST", "/v1.43/containers/abc123/start", false},
		{"POST", "/v1.43/containers/abc123/exec", false},
		{"POST", "/v1.43/images/create", false},
	}
	for _, tc := range cases {
		if got := isContainersCreate(tc.method, tc.uri); got != tc.want {
			t.Errorf("isContainersCreate(%q, %q) = %v, want %v", tc.method, tc.uri, got, tc.want)
		}
	}
}

func TestMergeConfig(t *testing.T) {
	dst := &config{AllowedCaps: map[string]bool{"NET_BIND_SERVICE": true}, BindAllowPrefixes: []string{"/code/"}}
	src := &config{AllowedCaps: map[string]bool{"SYS_PTRACE": true}, BindAllowPrefixes: []string{"/code/", "/tmp/scratch/"}}
	mergeConfig(dst, src)

	if !dst.AllowedCaps["NET_BIND_SERVICE"] || !dst.AllowedCaps["SYS_PTRACE"] {
		t.Errorf("merged caps = %v, want both NET_BIND_SERVICE and SYS_PTRACE", dst.AllowedCaps)
	}
	if len(dst.BindAllowPrefixes) != 2 {
		t.Errorf("merged bind prefixes = %v, want exactly 2 (dedup /code/)", dst.BindAllowPrefixes)
	}
}
