package cgroup

import (
	"context"
	"sync"
	"time"
)

// Point is one sample in a HistorySampler's ring buffer. Timestamp is left
// as a time.Time here (rather than unix-ms) since this package has no
// business knowing about JSON wire shapes — handlers_system.go converts.
type Point struct {
	Timestamp            time.Time
	CPUPercent           float64
	MemUsedBytes         uint64
	MemLimitBytes        *uint64
	DiskReadBytesPerSec  float64
	DiskWriteBytesPerSec float64
	NetRxBytesPerSec     float64
	NetTxBytesPerSec     float64

	// HostCPUCorePercent is HOST-WIDE per-core usage (see HostCPUSampler's
	// doc comment — not scoped to this container's cgroup), nil for this
	// tick if the read failed. Left nil rather than zeroed so callers can't
	// mistake "unavailable" for "genuinely idle"; HistorySampler's
	// hostCPUAvailable flag (returned by Snapshot) reflects the most recent
	// tick's success like diskIOAvailable/netIOAvailable already do.
	HostCPUCorePercent []float64

	// HostMemory* is a HOST-WIDE physical memory breakdown (see
	// HostMemory's doc comment — unrelated to MemUsedBytes/MemLimitBytes
	// above, which stay cgroup-scoped). Zeroed for this tick if the read
	// failed; HistorySampler's hostMemAvailable flag reflects the most
	// recent tick's success.
	HostMemTotalBytes   uint64
	HostMemFreeBytes    uint64
	HostMemBuffersBytes uint64
	HostMemCachedBytes  uint64
}

// rateTracker delta-samples a single cumulative counter (disk bytes, net
// bytes, ...) into a rate-per-second, the same idea as Sampler.CPU's
// usage_usec delta but generic over any uint64 counter. Not safe for
// concurrent use — HistorySampler only ever touches these from its own
// single ticker goroutine, so no internal locking is needed here (the
// HistorySampler's mutex only needs to guard the ring buffer, which is
// also read from HTTP handler goroutines via Snapshot).
type rateTracker struct {
	prevValue uint64
	prevAt    time.Time
	hasPrev   bool
}

// rate records current as the new sample and returns the rate-per-second
// since the previous call. The first call for a given tracker has nothing
// to diff against yet, so it legitimately returns 0 (not an error) — same
// convention as Sampler.CPU's first-sample behavior.
func (t *rateTracker) rate(now time.Time, current uint64) float64 {
	defer func() {
		t.prevValue = current
		t.prevAt = now
		t.hasPrev = true
	}()

	if !t.hasPrev {
		return 0
	}
	elapsed := now.Sub(t.prevAt).Seconds()
	if elapsed <= 0 {
		return 0
	}
	// A negative delta means the counter reset (e.g. an interface was
	// replaced) rather than actual negative traffic; clamp to 0 instead
	// of reporting garbage.
	if current < t.prevValue {
		return 0
	}
	return float64(current-t.prevValue) / elapsed
}

// HistorySampler background-samples cgroup/proc resource usage on a fixed
// interval into a fixed-capacity ring buffer, backing
// GET /api/system/resources/history. Construct once, run its Run method in
// its own goroutine for the server's lifetime, and read from it via
// Snapshot from as many HTTP handler goroutines as needed concurrently.
type HistorySampler struct {
	interval        time.Duration
	intervalSeconds int
	windowSeconds   int

	// cpu is this HistorySampler's own dedicated Sampler instance for
	// CPU delta-sampling — deliberately NOT the same instance as the
	// server's s.cgroupSampler used by the live GET /api/system/resources
	// endpoint. Sampler.CPU() deltas against whatever call happened
	// immediately before it on that specific instance; sharing one
	// between this regular 5s-tick goroutine and the live endpoint's
	// irregular per-HTTP-request calls would corrupt both callers'
	// baselines. Keep these separate.
	cpu *Sampler

	// hostCPU is this HistorySampler's own dedicated HostCPUSampler, same
	// "don't share delta-sampling state across independent pollers" reason
	// as cpu above.
	hostCPU *HostCPUSampler

	diskRead  rateTracker
	diskWrite rateTracker
	netRx     rateTracker
	netTx     rateTracker

	mu               sync.Mutex
	buf              []Point
	writeIdx         int
	filled           int
	diskIOAvailable  bool
	netIOAvailable   bool
	hostCPUAvailable bool
	hostMemAvailable bool
}

// NewHistorySampler builds a HistorySampler that samples every
// intervalSeconds and retains windowSeconds worth of history (capacity =
// windowSeconds/intervalSeconds, computed once here). Both are clamped to
// at least 1 so a bad/zero config value can't produce a zero-length ticker
// or a zero-capacity (i.e. always-empty) ring buffer.
func NewHistorySampler(intervalSeconds, windowSeconds int) *HistorySampler {
	if intervalSeconds < 1 {
		intervalSeconds = 1
	}
	if windowSeconds < intervalSeconds {
		windowSeconds = intervalSeconds
	}
	capacity := windowSeconds / intervalSeconds
	if capacity < 1 {
		capacity = 1
	}

	return &HistorySampler{
		interval: time.Duration(intervalSeconds) * time.Second,
		// windowSeconds reported back is the buffer's actual effective
		// span (capacity*intervalSeconds), which may differ slightly
		// from the requested windowSeconds due to integer division —
		// more honest than echoing the input back unchanged.
		intervalSeconds: intervalSeconds,
		windowSeconds:   capacity * intervalSeconds,
		cpu:             NewSampler(),
		hostCPU:         NewHostCPUSampler(),
		buf:             make([]Point, capacity),
	}
}

// IntervalSeconds returns the effective sampling interval, in seconds.
func (h *HistorySampler) IntervalSeconds() int { return h.intervalSeconds }

// WindowSeconds returns the ring buffer's effective retention window, in
// seconds (capacity * IntervalSeconds).
func (h *HistorySampler) WindowSeconds() int { return h.windowSeconds }

// Run samples on a ticker until ctx is cancelled. Intended to be started as
// `go s.Run(ctx)` once at server startup.
func (h *HistorySampler) Run(ctx context.Context) {
	ticker := time.NewTicker(h.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.sample()
		}
	}
}

// sample takes one reading of every metric and appends it to the ring
// buffer. Each metric degrades independently: a failed disk/net read
// records 0 for that tick's rate fields (CPU/mem for the same timestamp
// are still valid and worth keeping) but does update the
// diskIOAvailable/netIOAvailable flags, which reflect the most recent
// tick's success/failure rather than "ever succeeded" — so an
// environment where the io controller simply isn't enabled consistently
// reports unavailable instead of flapping.
func (h *HistorySampler) sample() {
	now := time.Now()

	cpuPercent, _, _, _ := h.cpu.CPU()
	memUsed, memLimit, memOK := Memory()
	if !memOK {
		memUsed, memLimit = 0, nil
	}

	var diskReadRate, diskWriteRate float64
	diskRead, diskWrite, diskOK := DiskIOBytes()
	if diskOK {
		diskReadRate = h.diskRead.rate(now, diskRead)
		diskWriteRate = h.diskWrite.rate(now, diskWrite)
	}

	var netRxRate, netTxRate float64
	netRx, netTx, netOK := NetworkIOBytes()
	if netOK {
		netRxRate = h.netRx.rate(now, netRx)
		netTxRate = h.netTx.rate(now, netTx)
	}

	hostCPUPercent, hostCPUOK := h.hostCPU.PerCorePercent()
	if !hostCPUOK {
		hostCPUPercent = nil
	}

	hostMem, hostMemOK := HostMemory()
	if !hostMemOK {
		hostMem = HostMemoryInfo{}
	}

	point := Point{
		Timestamp:            now,
		CPUPercent:           cpuPercent,
		MemUsedBytes:         memUsed,
		MemLimitBytes:        memLimit,
		DiskReadBytesPerSec:  diskReadRate,
		DiskWriteBytesPerSec: diskWriteRate,
		NetRxBytesPerSec:     netRxRate,
		NetTxBytesPerSec:     netTxRate,
		HostCPUCorePercent:   hostCPUPercent,
		HostMemTotalBytes:    hostMem.TotalBytes,
		HostMemFreeBytes:     hostMem.FreeBytes,
		HostMemBuffersBytes:  hostMem.BuffersBytes,
		HostMemCachedBytes:   hostMem.CachedBytes,
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	h.diskIOAvailable = diskOK
	h.netIOAvailable = netOK
	h.hostCPUAvailable = hostCPUOK
	h.hostMemAvailable = hostMemOK
	capacity := len(h.buf)
	h.buf[h.writeIdx] = point
	h.writeIdx = (h.writeIdx + 1) % capacity
	if h.filled < capacity {
		h.filled++
	}
}

// Snapshot returns a copy of the current buffer contents, oldest-first,
// plus whether the most recent tick's disk/net IO and host cpu/mem reads
// succeeded.
func (h *HistorySampler) Snapshot() (points []Point, diskIOAvailable, netIOAvailable, hostCPUAvailable, hostMemAvailable bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	capacity := len(h.buf)
	points = make([]Point, h.filled)
	if h.filled < capacity {
		// Buffer not full yet: not wrapped, oldest-first is simply
		// buf[0:filled] (writeIdx == filled in this state).
		copy(points, h.buf[:h.filled])
	} else {
		// Full and wrapped: the oldest entry is the one about to be
		// overwritten next, i.e. buf[writeIdx].
		n := copy(points, h.buf[h.writeIdx:])
		copy(points[n:], h.buf[:h.writeIdx])
	}
	return points, h.diskIOAvailable, h.netIOAvailable, h.hostCPUAvailable, h.hostMemAvailable
}
