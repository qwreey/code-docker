// Package procinfo wraps gopsutil's process/net sub-packages to back the
// webmanager "Processes" viewer (a browser replacement for opening btop
// inside the container to find and kill a stray listening process).
package procinfo

import (
	"context"
	"runtime"
	"sort"
	"sync"
	"time"

	gopsnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

// ProcessInfo is one row of GET /api/processes.
type ProcessInfo struct {
	PID        int32   `json:"pid"`
	PPID       int32   `json:"ppid"`
	Name       string  `json:"name"`
	Username   string  `json:"username"`
	Status     string  `json:"status"`
	CPUPercent float64 `json:"cpuPercent"`
	MemPercent float32 `json:"memPercent"`
	RSSBytes   uint64  `json:"rssBytes"`
	Cmdline    string  `json:"cmdline"`
}

// PortInfo is one row of GET /api/ports.
type PortInfo struct {
	Protocol     string `json:"protocol"`
	LocalAddress string `json:"localAddress"`
	LocalPort    uint32 `json:"localPort"`
	PID          int32  `json:"pid"`
	ProcessName  string `json:"processName"`
}

// cpuSample is one process's cumulative CPU time (user+system seconds, per
// gopsutil's cpu.TimesStat) at a point in time. The zero value (zero
// sampledAt) doubles as "no prior sample yet" so callers don't need a
// separate found/ok bool alongside the map lookup.
type cpuSample struct {
	cpuTime   float64
	sampledAt time.Time
}

// Sampler holds the previous-request CPU-time snapshot per pid so
// GET /api/processes can report a "recent rate" cpuPercent (like top/btop)
// instead of gopsutil's own lifetime-average single-snapshot number. Each
// HTTP request constructs fresh process.Process handles (gopsutil has no
// long-lived per-request object to cache its own last sample in), so this
// delta needs to be tracked here instead, with a lifetime matching the
// server process, not a single request.
type Sampler struct {
	mu      sync.Mutex
	samples map[int32]cpuSample
}

func NewSampler() *Sampler {
	return &Sampler{samples: make(map[int32]cpuSample)}
}

// getSamples and setSamples are the only places that touch s.samples, each
// holding s.mu only for the map read/assignment itself (mirrors
// cgroup.Sampler.CPU's lock-only-around-prev pattern) — the map object
// itself is never mutated in place after publish (only ever wholesale
// replaced under lock), so a snapshot returned by getSamples can safely be
// ranged over unlocked while the syscall-heavy gopsutil scan runs.
func (s *Sampler) getSamples() map[int32]cpuSample {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.samples
}

func (s *Sampler) setSamples(m map[int32]cpuSample) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.samples = m
}

// ListProcesses returns every process gopsutil can see, sorted by
// cpuPercent descending. Individual per-process lookup failures (a process
// exits between the initial PID listing and reading its details, permission
// races, etc.) are expected during a full-system scan — that process is
// silently skipped rather than failing the whole request. Username
// resolution failing on its own doesn't drop the whole process, just leaves
// that field empty, since it's the one lookup gopsutil documents as
// commonly best-effort (uid -> /etc/passwd).
func (s *Sampler) ListProcesses(ctx context.Context) ([]ProcessInfo, error) {
	procs, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	numCPU := runtime.NumCPU()
	result := make([]ProcessInfo, 0, len(procs))

	prevSamples := s.getSamples()
	newSamples := make(map[int32]cpuSample, len(procs))

	for _, p := range procs {
		info, cpuTime, ok := buildProcessInfo(ctx, p)
		if !ok {
			continue
		}
		info.CPUPercent = computeCPUPercent(prevSamples[p.Pid], cpuTime, now, numCPU)
		newSamples[p.Pid] = cpuSample{cpuTime: cpuTime, sampledAt: now}
		result = append(result, info)
	}

	s.setSamples(newSamples)

	sort.Slice(result, func(i, j int) bool {
		return result[i].CPUPercent > result[j].CPUPercent
	})
	return result, nil
}

// buildProcessInfo gathers everything but cpuPercent (that needs the
// caller's sampler lock/state). ok is false when any of the "core" fields
// fail to read, in which case the whole process is skipped rather than
// returned half-populated. cpuTime is the raw cumulative user+system seconds
// gopsutil reports, handed back so the caller can run it through the
// delta sampler.
func buildProcessInfo(ctx context.Context, p *process.Process) (info ProcessInfo, cpuTime float64, ok bool) {
	name, err := p.NameWithContext(ctx)
	if err != nil {
		return ProcessInfo{}, 0, false
	}

	ppid, err := p.PpidWithContext(ctx)
	if err != nil {
		return ProcessInfo{}, 0, false
	}

	statuses, err := p.StatusWithContext(ctx)
	if err != nil {
		return ProcessInfo{}, 0, false
	}
	status := ""
	if len(statuses) > 0 {
		status = statuses[0]
	}

	cmdline, err := p.CmdlineWithContext(ctx)
	if err != nil {
		return ProcessInfo{}, 0, false
	}

	memPercent, err := p.MemoryPercentWithContext(ctx)
	if err != nil {
		return ProcessInfo{}, 0, false
	}

	memInfo, err := p.MemoryInfoWithContext(ctx)
	if err != nil || memInfo == nil {
		return ProcessInfo{}, 0, false
	}

	times, err := p.TimesWithContext(ctx)
	if err != nil {
		return ProcessInfo{}, 0, false
	}

	// Best-effort only: leave blank rather than dropping the process.
	username, _ := p.UsernameWithContext(ctx)

	return ProcessInfo{
		PID:        p.Pid,
		PPID:       ppid,
		Name:       name,
		Username:   username,
		Status:     status,
		MemPercent: memPercent,
		RSSBytes:   memInfo.RSS,
		Cmdline:    cmdline,
	}, times.User + times.System, true
}

// computeCPUPercent implements the standard top/htop/btop delta-sampling
// technique: cpuPercent = (currentCPUTime - prevCPUTime) / secondsElapsed *
// 100. A pid with no prior sample (first time it's ever been seen by this
// server process) reports 0 instead of a meaningless lifetime-average-sized
// number.
//
// Normalization choice: the result is divided by runtime.NumCPU() and
// clamped to [0, 100], i.e. it represents percent of total system CPU
// capacity (matches e.g. htop's default "normalized" display) rather than
// percent of a single core (which could read up to 100*numCPU for a
// multi-threaded process, as plain `top` shows by default). Either
// convention is defensible; this one was picked so the number is always a
// plain 0-100 percentage without the frontend needing to know the
// container's core count to interpret it.
func computeCPUPercent(prev cpuSample, cpuTime float64, now time.Time, numCPU int) float64 {
	if prev.sampledAt.IsZero() {
		return 0
	}
	elapsed := now.Sub(prev.sampledAt).Seconds()
	if elapsed <= 0 {
		return 0
	}
	delta := cpuTime - prev.cpuTime
	if delta < 0 {
		delta = 0
	}
	if numCPU < 1 {
		numCPU = 1
	}
	pct := (delta / elapsed) * 100 / float64(numCPU)
	switch {
	case pct < 0:
		pct = 0
	case pct > 100:
		pct = 100
	}
	return pct
}

// ListPorts returns listening TCP sockets and all UDP sockets (UDP has no
// listen state, so "bound" is the closest equivalent), with pid/process
// name best-effort resolved. This is the equivalent of `ss -tulnp`.
func ListPorts(ctx context.Context) ([]PortInfo, error) {
	result := make([]PortInfo, 0)

	tcpConns, err := gopsnet.ConnectionsWithContext(ctx, "tcp")
	if err != nil {
		return nil, err
	}
	for _, c := range tcpConns {
		if c.Status != "LISTEN" {
			continue
		}
		result = append(result, buildPortInfo(ctx, "tcp", c))
	}

	udpConns, err := gopsnet.ConnectionsWithContext(ctx, "udp")
	if err != nil {
		return nil, err
	}
	for _, c := range udpConns {
		result = append(result, buildPortInfo(ctx, "udp", c))
	}

	return result, nil
}

// buildPortInfo resolves the owning process name for a connection's pid.
// Best-effort: pid 0 / process gone by the time we look it up just yields
// pid 0, processName "" rather than failing the whole /api/ports request.
func buildPortInfo(ctx context.Context, proto string, c gopsnet.ConnectionStat) PortInfo {
	info := PortInfo{
		Protocol:     proto,
		LocalAddress: c.Laddr.IP,
		LocalPort:    c.Laddr.Port,
	}
	if c.Pid <= 0 {
		return info
	}
	p, err := process.NewProcessWithContext(ctx, c.Pid)
	if err != nil {
		return info
	}
	name, err := p.NameWithContext(ctx)
	if err != nil {
		return info
	}
	info.PID = c.Pid
	info.ProcessName = name
	return info
}
