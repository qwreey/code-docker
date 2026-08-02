package main

import (
	"net/http"
	"syscall"

	"webmanager/internal/cgroup"
)

type memoryResources struct {
	UsedBytes  uint64  `json:"usedBytes"`
	LimitBytes *uint64 `json:"limitBytes"`
	// Available is false when this section degraded to zeroed fields
	// because its cgroup read failed, so callers can distinguish
	// "unavailable" from "genuinely zero" — the other fields keep their
	// exact prior meaning regardless.
	Available bool `json:"available"`
}

type cpuResources struct {
	Percent    float64  `json:"percent"`
	LimitCores *float64 `json:"limitCores"`
	NumCPU     int      `json:"numCpu"`
	Available  bool     `json:"available"`
}

type diskResources struct {
	Path       string `json:"path"`
	TotalBytes uint64 `json:"totalBytes"`
	UsedBytes  uint64 `json:"usedBytes"`
	FreeBytes  uint64 `json:"freeBytes"`
	Available  bool   `json:"available"`
}

type systemResources struct {
	Memory memoryResources `json:"memory"`
	CPU    cpuResources    `json:"cpu"`
	Disk   diskResources   `json:"disk"`
}

// handleSystemResources reports whole-container cpu/mem/disk usage read
// straight from this container's own cgroup v2 pseudo-files (see
// internal/cgroup), plus disk usage of the bind-mounted /code volume — the
// numbers `docker stats` would show on the host, which btop run inside the
// container can't see since it only has visibility into the container's
// own process list, not the cgroup accounting.
//
// Each of memory/cpu/disk degrades independently: an unreadable or
// unexpected-format cgroup file zeros/nulls just that section rather than
// failing the whole request. Only if literally none of the three could be
// read at all does this fall back to 503, as a last resort.
func (s *Server) handleSystemResources(w http.ResponseWriter, r *http.Request) {
	usedBytes, limitBytes, memOK := cgroup.Memory()
	percent, limitCores, numCPU, cpuOK := s.cgroupSampler.CPU()
	disk, diskOK := readDiskUsage(s.cfg.SystemDiskPath)

	if !memOK && !cpuOK && !diskOK {
		writeError(w, http.StatusServiceUnavailable, "cgroup v2 data unavailable")
		return
	}

	disk.Available = diskOK

	writeJSON(w, http.StatusOK, systemResources{
		Memory: memoryResources{UsedBytes: usedBytes, LimitBytes: limitBytes, Available: memOK},
		CPU:    cpuResources{Percent: percent, LimitCores: limitCores, NumCPU: numCPU, Available: cpuOK},
		Disk:   disk,
	})
}

// readDiskUsage matches df(1)'s own convention rather than a naive
// total-minus-Bavail subtraction: usedBytes is Blocks-minus-Bfree (blocks
// not free, whether or not an unprivileged process could claim them), and
// freeBytes is Bavail (blocks actually available to this process — usually
// slightly less than raw-free due to the filesystem's reserved-for-root
// margin). The two can therefore not sum exactly to totalBytes; that's
// expected and matches what `df` itself reports.
func readDiskUsage(path string) (diskResources, bool) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return diskResources{Path: path}, false
	}
	bsize := uint64(stat.Bsize)
	total := stat.Blocks * bsize
	free := stat.Bavail * bsize
	used := total - stat.Bfree*bsize
	return diskResources{
		Path:       path,
		TotalBytes: total,
		UsedBytes:  used,
		FreeBytes:  free,
	}, true
}
