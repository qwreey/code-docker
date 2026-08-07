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
			Type          string `json:"Type"`
			Source        string `json:"Source"`
			VolumeOptions *struct {
				DriverConfig *struct {
					Name    string            `json:"Name"`
					Options map[string]string `json:"Options"`
				} `json:"DriverConfig"`
			} `json:"VolumeOptions"`
		} `json:"Mounts"`
	} `json:"HostConfig"`
}

// volumeCreateBody is the subset of a POST .../volumes/create request body
// this plugin inspects — the "local" driver options here use the same
// bind-passthrough mechanism as a Mounts[].VolumeOptions.DriverConfig entry
// above, just under the top-level Driver/DriverOpts field names Docker uses
// for this endpoint instead.
type volumeCreateBody struct {
	Driver     string            `json:"Driver"`
	DriverOpts map[string]string `json:"DriverOpts"`
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

// isVolumesCreate reports whether a request is a "create a volume" call —
// gated the same way as isContainersCreate, since a malicious named volume
// created here (with bind-passthrough driver options) could otherwise be
// pre-created unevaluated and referenced by name in a later container
// create's Mounts/Binds.
func isVolumesCreate(method, uri string) bool {
	if method != "POST" {
		return false
	}
	u := uri
	if i := strings.IndexByte(u, '?'); i >= 0 {
		u = u[:i]
	}
	return path.Base(u) == "create" && strings.HasSuffix(path.Dir(u), "/volumes")
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
		switch m.Type {
		case "bind":
			if !bindSourceAllowed(m.Source, cfg.BindAllowPrefixes) {
				return false, "bind mount source not allowed: " + m.Source
			}
		case "volume":
			var driverName string
			var opts map[string]string
			if m.VolumeOptions != nil && m.VolumeOptions.DriverConfig != nil {
				driverName = m.VolumeOptions.DriverConfig.Name
				opts = m.VolumeOptions.DriverConfig.Options
			}
			if !driverOptsAllowed(driverName, opts, cfg.BindAllowPrefixes) {
				return false, "volume mount driver options not allowed (bind-mount passthrough): " + m.Source
			}
		}
	}

	return true, ""
}

// evaluateVolumeCreate decides whether a POST .../volumes/create request is
// allowed under cfg — the "local" driver's type=none/o=bind/device=<path>
// options perform an arbitrary host bind mount despite the request being
// nominally a "volume", so this closes the same hole evaluate()'s Mounts
// handling does, for a volume created ahead of time and referenced by name
// in a later container-create call instead of inlined directly.
func evaluateVolumeCreate(body []byte, cfg *config) (allow bool, reason string) {
	var req volumeCreateBody
	if err := json.Unmarshal(body, &req); err != nil {
		return true, ""
	}
	if !driverOptsAllowed(req.Driver, req.DriverOpts, cfg.BindAllowPrefixes) {
		return false, "volume driver options not allowed (bind-mount passthrough)"
	}
	return true, ""
}

// driverOptsAllowed reports whether a volume's driver+options are safe: a
// plain named/anonymous volume with the default (or no) driver and no
// options lives entirely inside dind's own storage and is always safe. Any
// driver options at all are only allowed if they don't request a host bind
// passthrough — recognized here by the presence of a "device" option, the
// "local" driver's trigger for treating the volume as a bind mount of that
// host path (typically paired with "o=bind"/"type=none", but the device key
// alone is treated as the meaningful signal so this fails closed rather than
// pattern-matching every way to spell "bind"). An unrecognized (non-empty,
// non-"local") driver name can't be reasoned about at all, so it's only
// allowed with zero options.
func driverOptsAllowed(driverName string, opts map[string]string, allowRoots []string) bool {
	if driverName != "" && driverName != "local" {
		return len(opts) == 0
	}
	if len(opts) == 0 {
		return true
	}
	device, hasDevice := opts["device"]
	if !hasDevice {
		return true
	}
	return bindSourceAllowed(device, allowRoots)
}

// bindSourceAllowed reports whether src is safe as a bind-mount source.
// Named volumes (a source that isn't an absolute path) are always allowed
// — they live inside dind's own storage, not the host filesystem. Absolute
// paths must equal, or fall under, one of the configured allow-list roots
// (each entry may be given with or without a trailing slash — "/code" and
// "/code/" mean the same root). Both src and each root are lexically
// cleaned (path.Clean) before comparison — without this, a source like
// "/code/../etc" textually satisfies a raw prefix check while actually
// resolving (at the mount() syscall / runc layer) to a path outside every
// allowed root.
func bindSourceAllowed(src string, allowRoots []string) bool {
	if !strings.HasPrefix(src, "/") {
		return true
	}
	cleanSrc := path.Clean(src)
	for _, root := range allowRoots {
		cleanRoot := path.Clean(root)
		if cleanSrc == cleanRoot || strings.HasPrefix(cleanSrc, cleanRoot+"/") {
			return true
		}
	}
	return false
}
