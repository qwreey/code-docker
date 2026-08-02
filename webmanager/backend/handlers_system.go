package main

import (
	"net/http"
	"syscall"

	"webmanager/internal/cgroup"
)

// ResourceHistoryPoint is one sample of GET /api/system/resources/history.
// Timestamp is unix milliseconds (JS-friendly, matches the frontend's
// frozen contract).
type ResourceHistoryPoint struct {
	Timestamp            int64   `json:"timestamp"`
	CPUPercent           float64 `json:"cpuPercent"`
	MemUsedBytes         uint64  `json:"memUsedBytes"`
	MemLimitBytes        *uint64 `json:"memLimitBytes"`
	DiskReadBytesPerSec  float64 `json:"diskReadBytesPerSec"`
	DiskWriteBytesPerSec float64 `json:"diskWriteBytesPerSec"`
	NetRxBytesPerSec     float64 `json:"netRxBytesPerSec"`
	NetTxBytesPerSec     float64 `json:"netTxBytesPerSec"`

	// HostPerCorePercent is HOST-WIDE per-core CPU usage for this tick (see
	// cpuCoreResources below for the full caveat) — nil/omitted for ticks
	// where the read failed; check the response-level HostCPUAvailable
	// flag rather than per-point nil-ness to distinguish "this container
	// has no visibility at all" from "this one tick happened to fail".
	HostPerCorePercent []float64 `json:"hostPerCorePercent,omitempty"`

	// HostMem* is a HOST-WIDE physical memory breakdown for this tick (see
	// hostMemoryResources below) — unrelated to MemUsedBytes/MemLimitBytes
	// above, which stay cgroup-scoped. Zeroed for ticks where the read
	// failed; check the response-level HostMemAvailable flag.
	HostMemTotalBytes   uint64 `json:"hostMemTotalBytes"`
	HostMemFreeBytes    uint64 `json:"hostMemFreeBytes"`
	HostMemBuffersBytes uint64 `json:"hostMemBuffersBytes"`
	HostMemCachedBytes  uint64 `json:"hostMemCachedBytes"`
}

// ResourceHistoryResponse is the body of GET /api/system/resources/history.
type ResourceHistoryResponse struct {
	IntervalSeconds int  `json:"intervalSeconds"`
	WindowSeconds   int  `json:"windowSeconds"`
	DiskIOAvailable bool `json:"diskIOAvailable"`
	NetIOAvailable  bool `json:"netIOAvailable"`
	// HostCPUAvailable/HostMemAvailable reflect the most recent sampling
	// tick's success, same convention as DiskIOAvailable/NetIOAvailable
	// above (see HistorySampler.sample's doc comment).
	HostCPUAvailable bool                   `json:"hostCpuAvailable"`
	HostMemAvailable bool                   `json:"hostMemAvailable"`
	Points           []ResourceHistoryPoint `json:"points"`
}

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

// hostMemoryResources is a HOST-WIDE physical memory breakdown (from
// /proc/meminfo via cgroup.HostMemory) — deliberately separate from and
// unrelated to memoryResources above, which stays cgroup-scoped
// (memory.current/memory.max). Exposed side by side so the frontend can
// show "cgroup: used/limit" next to "host physical: total/breakdown",
// which matters most when memoryResources.LimitBytes is nil (no cgroup
// limit configured) since the host's physical total is still a meaningful
// ceiling to display even then.
type hostMemoryResources struct {
	TotalBytes   uint64 `json:"totalBytes"`
	FreeBytes    uint64 `json:"freeBytes"`
	BuffersBytes uint64 `json:"buffersBytes"`
	// CachedBytes folds /proc/meminfo's Cached and SReclaimable together —
	// see cgroup.HostMemoryInfo's doc comment.
	CachedBytes uint64 `json:"cachedBytes"`
	Available   bool   `json:"available"`
}

// cpuCoreResources is HOST-WIDE per-core CPU usage (from /proc/stat via
// cgroup.HostCPUSampler), NOT scoped to this container's cgroup — cgroup v2
// has no per-core accounting at all (only an aggregate usage_usec, which is
// what cpuResources.Percent above is derived from), so this reports every
// core on the host regardless of what this container's own cpu.max quota
// or cpuset actually allows it to use. The "host" prefix throughout this
// type's field names/JSON keys is deliberate — the frontend must not
// present this as container-scoped usage.
type cpuCoreResources struct {
	HostPercent []float64 `json:"hostPercent"`
	// HostClockMHz is a parallel array to HostPercent (same index = same
	// core) — omitted entirely (nil) rather than zero-filled when
	// unavailable, which is the common case inside a container without
	// host sysfs cpufreq access.
	HostClockMHz []float64 `json:"hostClockMHz,omitempty"`
	Available    bool      `json:"available"`
}

// thermalZone is one best-effort-readable /sys/class/thermal/thermal_zoneN.
// See cgroup.HostSensors.Thermal's doc comment: there's no reliable
// universal "this one is the CPU" label, so every readable zone is
// returned (CPU-looking ones sorted first) and the frontend decides what to
// show.
type thermalZone struct {
	Label   string  `json:"label"`
	Celsius float64 `json:"celsius"`
}

type systemResources struct {
	Memory     memoryResources     `json:"memory"`
	CPU        cpuResources        `json:"cpu"`
	Disk       diskResources       `json:"disk"`
	HostMemory hostMemoryResources `json:"hostMemory"`
	CPUCores   cpuCoreResources    `json:"cpuCores"`
	// Thermal is best-effort and frequently empty/unavailable inside a
	// container (no host sysfs thermal access) — that's expected, not an
	// error; an empty slice here just means "no zones were readable", no
	// separate available flag needed since an empty list already conveys
	// that unambiguously (unlike the other sections, there's no
	// meaningful "zeroed but available" state to distinguish it from).
	Thermal []thermalZone `json:"thermal"`
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

	hostMem, hostMemOK := cgroup.HostMemory()
	hostPercent, hostCPUOK := s.hostCPUSampler.PerCorePercent()
	hostClockMHz, clockOK := s.hostSensors.ClockMHz()
	if !clockOK {
		hostClockMHz = nil
	}
	zones, _ := s.hostSensors.Thermal()
	thermal := make([]thermalZone, len(zones))
	for i, z := range zones {
		thermal[i] = thermalZone{Label: z.Label, Celsius: z.Celsius}
	}

	writeJSON(w, http.StatusOK, systemResources{
		Memory: memoryResources{UsedBytes: usedBytes, LimitBytes: limitBytes, Available: memOK},
		CPU:    cpuResources{Percent: percent, LimitCores: limitCores, NumCPU: numCPU, Available: cpuOK},
		Disk:   disk,
		HostMemory: hostMemoryResources{
			TotalBytes:   hostMem.TotalBytes,
			FreeBytes:    hostMem.FreeBytes,
			BuffersBytes: hostMem.BuffersBytes,
			CachedBytes:  hostMem.CachedBytes,
			Available:    hostMemOK,
		},
		CPUCores: cpuCoreResources{
			HostPercent:  hostPercent,
			HostClockMHz: hostClockMHz,
			Available:    hostCPUOK,
		},
		Thermal: thermal,
	})
}

// handleSystemResourcesHistory reports the background-sampled resource
// history ring buffer built by s.resourceHistory (its own dedicated
// sampler goroutine, started in main.go — see the field's doc comment for
// why it must not share cgroup.Sampler state with s.cgroupSampler above).
func (s *Server) handleSystemResourcesHistory(w http.ResponseWriter, r *http.Request) {
	samples, diskOK, netOK, hostCPUOK, hostMemOK := s.resourceHistory.Snapshot()

	points := make([]ResourceHistoryPoint, len(samples))
	for i, p := range samples {
		points[i] = ResourceHistoryPoint{
			Timestamp:            p.Timestamp.UnixMilli(),
			CPUPercent:           p.CPUPercent,
			MemUsedBytes:         p.MemUsedBytes,
			MemLimitBytes:        p.MemLimitBytes,
			DiskReadBytesPerSec:  p.DiskReadBytesPerSec,
			DiskWriteBytesPerSec: p.DiskWriteBytesPerSec,
			NetRxBytesPerSec:     p.NetRxBytesPerSec,
			NetTxBytesPerSec:     p.NetTxBytesPerSec,
			HostPerCorePercent:   p.HostCPUCorePercent,
			HostMemTotalBytes:    p.HostMemTotalBytes,
			HostMemFreeBytes:     p.HostMemFreeBytes,
			HostMemBuffersBytes:  p.HostMemBuffersBytes,
			HostMemCachedBytes:   p.HostMemCachedBytes,
		}
	}

	writeJSON(w, http.StatusOK, ResourceHistoryResponse{
		IntervalSeconds:  s.resourceHistory.IntervalSeconds(),
		WindowSeconds:    s.resourceHistory.WindowSeconds(),
		DiskIOAvailable:  diskOK,
		NetIOAvailable:   netOK,
		HostCPUAvailable: hostCPUOK,
		HostMemAvailable: hostMemOK,
		Points:           points,
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
