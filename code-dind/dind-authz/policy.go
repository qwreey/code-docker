package main

import (
	"encoding/json"
	"path"
	"strings"
)

// config is the merged conf.d policy data: what's explicitly allowed.
// Anything not listed here is denied by default (undefined == false).
type config struct {
	AllowedCaps       map[string]bool `json:"allowed_caps"`
	BindAllowPrefixes []string        `json:"bind_allow_prefixes"`
}

func mergeConfig(dst, src *config) {
	if dst.AllowedCaps == nil {
		dst.AllowedCaps = map[string]bool{}
	}
	for k, v := range src.AllowedCaps {
		if v {
			dst.AllowedCaps[k] = true
		}
	}
	for _, p := range src.BindAllowPrefixes {
		exists := false
		for _, have := range dst.BindAllowPrefixes {
			if have == p {
				exists = true
				break
			}
		}
		if !exists {
			dst.BindAllowPrefixes = append(dst.BindAllowPrefixes, p)
		}
	}
}

// createBody is the subset of a POST .../containers/create request body
// this plugin inspects. Every other field passes through untouched.
type createBody struct {
	HostConfig struct {
		Privileged        bool              `json:"Privileged"`
		CapAdd            []string          `json:"CapAdd"`
		SecurityOpt       []string          `json:"SecurityOpt"`
		PidMode           string            `json:"PidMode"`
		NetworkMode       string            `json:"NetworkMode"`
		IpcMode           string            `json:"IpcMode"`
		CgroupnsMode      string            `json:"CgroupnsMode"`
		Devices           []json.RawMessage `json:"Devices"`
		DeviceCgroupRules []string          `json:"DeviceCgroupRules"`
		Binds             []string          `json:"Binds"`
		Mounts            []struct {
			Type   string `json:"Type"`
			Source string `json:"Source"`
		} `json:"Mounts"`
	} `json:"HostConfig"`
}

// isContainersCreate reports whether a request is a "create a container"
// call, independent of the /v1.NN/ API-version prefix Docker clients send.
func isContainersCreate(method, uri string) bool {
	if method != "POST" {
		return false
	}
	u := uri
	if i := strings.IndexByte(u, '?'); i >= 0 {
		u = u[:i]
	}
	return path.Base(u) == "create" && strings.HasSuffix(path.Dir(u), "/containers")
}

// evaluate decides whether a container-create request is allowed under cfg.
// docker update cannot change Privileged/CapAdd/SecurityOpt/*Mode/Devices on
// an existing container (the Engine API itself rejects that), so gating
// only the create call is sufficient for the fields checked here.
func evaluate(body []byte, cfg *config) (allow bool, reason string) {
	var req createBody
	if err := json.Unmarshal(body, &req); err != nil {
		// Malformed body: let the daemon's own validation reject it
		// rather than us guessing what's wrong.
		return true, ""
	}
	hc := req.HostConfig

	if hc.Privileged {
		return false, "privileged containers are not allowed"
	}
	for _, capName := range hc.CapAdd {
		normalized := strings.ToUpper(strings.TrimPrefix(capName, "CAP_"))
		if !cfg.AllowedCaps[normalized] {
			return false, "capability not in allow-list: " + capName
		}
	}
	for _, opt := range hc.SecurityOpt {
		lower := strings.ToLower(opt)
		if strings.Contains(lower, "seccomp=unconfined") ||
			strings.Contains(lower, "seccomp:unconfined") ||
			strings.Contains(lower, "apparmor=unconfined") ||
			strings.Contains(lower, "apparmor:unconfined") ||
			strings.Contains(lower, "label=disable") ||
			strings.Contains(lower, "label:disable") {
			return false, "disabling seccomp/apparmor/labeling is not allowed: " + opt
		}
	}
	if hc.PidMode == "host" {
		return false, "pid=host is not allowed"
	}
	if hc.NetworkMode == "host" {
		return false, "network=host is not allowed"
	}
	if hc.IpcMode == "host" {
		return false, "ipc=host is not allowed"
	}
	if hc.CgroupnsMode == "host" {
		return false, "cgroupns=host is not allowed"
	}
	if len(hc.Devices) > 0 {
		return false, "device passthrough is not allowed"
	}
	if len(hc.DeviceCgroupRules) > 0 {
		return false, "device cgroup rules are not allowed"
	}
	for _, b := range hc.Binds {
		src := b
		if i := strings.IndexByte(b, ':'); i >= 0 {
			src = b[:i]
		}
		if !bindSourceAllowed(src, cfg.BindAllowPrefixes) {
			return false, "bind mount source not allowed: " + src
		}
	}
	for _, m := range hc.Mounts {
		if m.Type == "bind" && !bindSourceAllowed(m.Source, cfg.BindAllowPrefixes) {
			return false, "bind mount source not allowed: " + m.Source
		}
	}

	return true, ""
}

// bindSourceAllowed reports whether src is safe as a bind-mount source.
// Named volumes (a source that isn't an absolute path) are always allowed
// — they live inside dind's own storage, not the host filesystem. Absolute
// paths must equal, or fall under, one of the configured allow-list roots
// (each entry may be given with or without a trailing slash — "/code" and
// "/code/" mean the same root).
func bindSourceAllowed(src string, allowRoots []string) bool {
	if !strings.HasPrefix(src, "/") {
		return true
	}
	for _, root := range allowRoots {
		root = strings.TrimSuffix(root, "/")
		if src == root || strings.HasPrefix(src, root+"/") {
			return true
		}
	}
	return false
}
