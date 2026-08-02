// This file adds HOST-WIDE readings alongside cgroup.go's container-scoped
// ones — /proc/stat (per-core CPU), /proc/meminfo (physical memory), and
// best-effort /sys cpufreq/thermal nodes. None of these go through the
// cgroup v2 dir() resolution above: they're not container-scoped at all,
// which is exactly the point (see each function's doc comment) and also why
// they work identically regardless of whether cgroup v2 is even in use.
package cgroup

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// parseCPUIndex extracts N from a "cpuN" label (either a /proc/stat field
// label or a /sys/devices/system/cpu/cpuN directory name) — shared by the
// per-core CPU and clock-speed readers below since both need the same
// "strip the cpu prefix, parse the rest as an int" logic.
func parseCPUIndex(label string) (int, bool) {
	if !strings.HasPrefix(label, "cpu") {
		return 0, false
	}
	n, err := strconv.Atoi(label[3:])
	if err != nil {
		return 0, false
	}
	return n, true
}

// hostCoreJiffies is one core's cumulative /proc/stat counters at a point in
// time: total is the sum of every field (user+nice+system+idle+iowait+irq+
// softirq+steal+guest+guest_nice), idle is just idle+iowait — the same
// split used by every "top"-style tool to compute busy% from /proc/stat.
type hostCoreJiffies struct {
	total uint64
	idle  uint64
}

// readProcStatPerCore parses /proc/stat's per-core lines ("cpu0 ", "cpu1 ",
// ... — the trailing space is what distinguishes them from the aggregate
// "cpu " line; using strings.Fields to split means we compare against the
// exact label "cpu" instead of needing to check for the space directly).
// Fields after the label are, in order: user nice system idle iowait irq
// softirq steal guest guest_nice, in USER_HZ jiffies. Not every kernel
// exposes all ten (guest/guest_nice are newer); any present are summed into
// total and idle/iowait are read positionally when present.
func readProcStatPerCore(path string) (map[int]hostCoreJiffies, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	out := make(map[int]hostCoreJiffies)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 5 {
			continue
		}
		label := fields[0]
		if label == "cpu" {
			// The aggregate line, not a per-core one — skip.
			continue
		}
		idx, ok := parseCPUIndex(label)
		if !ok {
			continue
		}

		var total uint64
		var idle uint64
		for i, tok := range fields[1:] {
			v, err := strconv.ParseUint(tok, 10, 64)
			if err != nil {
				continue
			}
			total += v
			// i==3 -> idle, i==4 -> iowait (0-indexed: user=0 nice=1
			// system=2 idle=3 iowait=4 ...).
			if i == 3 || i == 4 {
				idle += v
			}
		}
		out[idx] = hostCoreJiffies{total: total, idle: idle}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no per-core cpu lines found in %s", path)
	}
	return out, nil
}

// HostCPUSampler delta-samples /proc/stat's per-core lines to report each
// HOST core's busy percentage since the previous sample — analogous to
// Sampler.CPU's delta-over-time idea, but with its own dedicated
// previous-sample state (core index -> previous jiffies) since it measures
// a completely different thing.
//
// IMPORTANT: this is HOST-WIDE data, not scoped to this container's cgroup.
// cgroup v2 has no per-core accounting at all — only an aggregate
// usage_usec via cpu.stat (see Sampler.CPU above) — so a per-core breakdown
// can only come from /proc/stat, which reports every core on the host
// regardless of what this container's own cpu.max quota or cpuset actually
// allows it to use. Every consumer of this type's output (JSON field names
// in handlers_system.go, frontend labels) must make that distinction
// visible rather than implying "container per-core usage".
//
// Must be constructed once and held for the server's lifetime, same
// delta-sampling reason as Sampler.
type HostCPUSampler struct {
	mu     sync.Mutex
	prev   map[int]hostCoreJiffies
	prevAt time.Time
}

func NewHostCPUSampler() *HostCPUSampler {
	return &HostCPUSampler{}
}

// PerCorePercent returns one busy-percent entry per host core, indexed by
// core number (percent[N] is core N's usage — any gap in core numbering,
// which shouldn't normally happen on Linux, is simply left at 0). ok is
// false only when /proc/stat itself couldn't be read/parsed. Like
// Sampler.CPU, the very first call legitimately returns all-zero percents
// with ok true — nothing to diff against yet is not a failure.
func (s *HostCPUSampler) PerCorePercent() (percent []float64, ok bool) {
	cur, err := readProcStatPerCore("/proc/stat")
	if err != nil {
		return nil, false
	}
	now := time.Now()

	s.mu.Lock()
	prev := s.prev
	prevAt := s.prevAt
	s.prev = cur
	s.prevAt = now
	s.mu.Unlock()

	maxIdx := -1
	for idx := range cur {
		if idx > maxIdx {
			maxIdx = idx
		}
	}
	percent = make([]float64, maxIdx+1)

	if prevAt.IsZero() {
		return percent, true
	}
	elapsed := now.Sub(prevAt).Seconds()
	if elapsed <= 0 {
		return percent, true
	}

	for idx, c := range cur {
		p, had := prev[idx]
		if !had {
			continue
		}
		totalDelta := int64(c.total) - int64(p.total)
		if totalDelta <= 0 {
			continue
		}
		idleDelta := int64(c.idle) - int64(p.idle)
		busyDelta := totalDelta - idleDelta
		if busyDelta < 0 {
			busyDelta = 0
		}
		pct := float64(busyDelta) / float64(totalDelta) * 100
		switch {
		case pct < 0:
			pct = 0
		case pct > 100:
			pct = 100
		}
		percent[idx] = pct
	}
	return percent, true
}

// HostMemoryInfo is a HOST-WIDE physical memory breakdown read from
// /proc/meminfo. Like HostCPUSampler above, this is deliberately separate
// from and unrelated to Memory() (this package's cgroup-scoped
// memory.current/memory.max reader, which stays exactly as-is) — the two
// are meant to be shown side by side by the frontend ("cgroup: used/limit"
// next to "host physical: total/breakdown"), which matters most when the
// cgroup has no memory limit configured (Memory()'s limitBytes is nil) since
// the host's physical total is still a meaningful ceiling to display even
// then.
type HostMemoryInfo struct {
	TotalBytes   uint64
	FreeBytes    uint64
	BuffersBytes uint64
	// CachedBytes folds /proc/meminfo's Cached and SReclaimable (reclaimable
	// slab, e.g. dentry/inode caches) together into one "cache-like" bucket,
	// the same convention tools like btop use for a used/cache/buffers/free
	// breakdown.
	CachedBytes uint64
}

// HostMemory reads /proc/meminfo. ok is false only if the file couldn't be
// read or didn't contain a MemTotal line at all (which would indicate
// something is very wrong, not just a missing optional field) — every other
// field defaults to 0 if its line is absent, which is an accurate reading
// on kernels that don't report it rather than a degraded one.
func HostMemory() (HostMemoryInfo, bool) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return HostMemoryInfo{}, false
	}
	defer f.Close()

	vals := make(map[string]uint64)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		key, rest, ok := strings.Cut(scanner.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		// Every /proc/meminfo value is reported in kB (the unit suffix
		// shown after the number is always "kB" in practice) -- convert to
		// bytes here so callers never have to think about units.
		vals[key] = n * 1024
	}
	if err := scanner.Err(); err != nil {
		return HostMemoryInfo{}, false
	}

	total, hasTotal := vals["MemTotal"]
	if !hasTotal {
		return HostMemoryInfo{}, false
	}

	return HostMemoryInfo{
		TotalBytes:   total,
		FreeBytes:    vals["MemFree"],
		BuffersBytes: vals["Buffers"],
		CachedBytes:  vals["Cached"] + vals["SReclaimable"],
	}, true
}

// ThermalZone is one readable /sys/class/thermal/thermal_zoneN, labeled by
// its "type" file when present (falls back to the zone's directory name
// otherwise) since there's no universally reliable "this one is the CPU"
// marker across hosts/kernels.
type ThermalZone struct {
	Label   string
	Celsius float64
}

// HostSensors best-effort-reads host cpufreq/thermal sysfs nodes, which are
// frequently unavailable inside a container (no access to the host's sysfs
// cpufreq/thermal nodes, depending on the container runtime/host) — that's
// expected and fine, not an error condition. Whether each kind of reading
// is available AT ALL is probed on first use and cached, so a container
// without access doesn't repeat a failing glob on every single poll — the
// same "try once, remember the flag" idea as HistorySampler's
// diskIOAvailable/netIOAvailable, just probed lazily on first call rather
// than on a fixed schedule since these back live "gauge" reads, not
// sampled history. Once confirmed available, every call still does a fresh
// read (these are live values, not something to cache the contents of).
//
// Must be constructed once and held for the server's lifetime so the
// availability cache actually has an effect.
type HostSensors struct {
	mu sync.Mutex

	clockChecked   bool
	clockAvailable bool

	thermalChecked   bool
	thermalAvailable bool
}

func NewHostSensors() *HostSensors {
	return &HostSensors{}
}

// ClockMHz best-effort reads each host core's current clock speed from
// /sys/devices/system/cpu/cpuN/cpufreq/scaling_cur_freq (kHz on disk,
// converted to MHz here). Indexed by core number like
// HostCPUSampler.PerCorePercent, so the two arrays line up positionally.
// ok is false if no cpufreq node was readable at all (typical inside a
// container without host sysfs access).
func (s *HostSensors) ClockMHz() (perCore []float64, ok bool) {
	s.mu.Lock()
	checked, available := s.clockChecked, s.clockAvailable
	s.mu.Unlock()
	if checked && !available {
		return nil, false
	}

	matches, _ := filepath.Glob("/sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq")

	found := make(map[int]float64)
	maxIdx := -1
	for _, m := range matches {
		// m looks like .../cpu3/cpufreq/scaling_cur_freq; the core dir is
		// two levels up.
		coreDir := filepath.Base(filepath.Dir(filepath.Dir(m)))
		idx, ok := parseCPUIndex(coreDir)
		if !ok {
			continue
		}
		data, err := os.ReadFile(m)
		if err != nil {
			continue
		}
		khz, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
		if err != nil {
			continue
		}
		found[idx] = float64(khz) / 1000
		if idx > maxIdx {
			maxIdx = idx
		}
	}

	s.mu.Lock()
	s.clockChecked = true
	s.clockAvailable = maxIdx >= 0
	s.mu.Unlock()

	if maxIdx < 0 {
		return nil, false
	}
	perCore = make([]float64, maxIdx+1)
	for idx, mhz := range found {
		perCore[idx] = mhz
	}
	return perCore, true
}

// looksLikeCPUZone is a best-effort heuristic for picking out "the" CPU
// thermal zone among several with no reliable universal label — matched
// against known naming conventions (x86_pkg_temp, coretemp) plus a generic
// "cpu" substring check for anything else.
func looksLikeCPUZone(label string) bool {
	l := strings.ToLower(label)
	return strings.Contains(l, "cpu") || strings.Contains(l, "x86_pkg_temp") || strings.Contains(l, "coretemp")
}

// Thermal best-effort reads every /sys/class/thermal/thermal_zoneN/temp
// (millidegrees C, converted to whole degrees here), labeling each from its
// sibling "type" file when readable. Zones that look CPU-related (see
// looksLikeCPUZone) are sorted first so a caller that just wants "the" CPU
// temperature can take index 0, but every readable zone is still returned —
// there's no reliable universal label, so the frontend gets to decide what
// to show. ok is false if no zone was readable at all.
func (s *HostSensors) Thermal() ([]ThermalZone, bool) {
	s.mu.Lock()
	checked, available := s.thermalChecked, s.thermalAvailable
	s.mu.Unlock()
	if checked && !available {
		return nil, false
	}

	matches, _ := filepath.Glob("/sys/class/thermal/thermal_zone*/temp")

	var zones []ThermalZone
	for _, m := range matches {
		data, err := os.ReadFile(m)
		if err != nil {
			continue
		}
		milli, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
		if err != nil {
			continue
		}
		label := filepath.Base(filepath.Dir(m))
		if typeData, err := os.ReadFile(filepath.Join(filepath.Dir(m), "type")); err == nil {
			if t := strings.TrimSpace(string(typeData)); t != "" {
				label = t
			}
		}
		zones = append(zones, ThermalZone{Label: label, Celsius: float64(milli) / 1000})
	}

	sort.SliceStable(zones, func(i, j int) bool {
		return looksLikeCPUZone(zones[i].Label) && !looksLikeCPUZone(zones[j].Label)
	})

	s.mu.Lock()
	s.thermalChecked = true
	s.thermalAvailable = len(zones) > 0
	s.mu.Unlock()

	if len(zones) == 0 {
		return nil, false
	}
	return zones, true
}
