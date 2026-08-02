// Package cgroup reads the container's own cgroup v2 pseudo-files to
// report whole-container cpu/mem usage against the limits `docker stats`
// would show on the host — a container can always read its own cgroup, no
// docker.sock or host access needed. This backs GET /api/system/resources,
// graduating the research done in webmanager/ideas.md's "컨테이너 전체
// cpu/mem/disk 리소스 추적" section.
//
// cgroup v1 is explicitly not supported (ideas.md already flagged it as a
// known gap; modern Arch/Docker default to v2) — reads simply fail there
// and callers are expected to degrade gracefully instead of the whole
// endpoint crashing.
package cgroup

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const sysFsCgroup = "/sys/fs/cgroup"

// dir resolves the cgroup v2 directory backing the calling process: the
// unified-hierarchy ("0::") entry from /proc/self/cgroup, joined onto
// /sys/fs/cgroup. Inside a real Docker container this is almost always
// "/sys/fs/cgroup" itself — Docker gives each container its own cgroup
// namespace, so /proc/self/cgroup there just reads "0::/" — but resolving
// it properly (rather than hardcoding the root) also makes this work
// unmodified in environments without per-container cgroup namespaces, e.g.
// a plain dev sandbox where the process's cgroup is nested many levels
// deep under the host's real hierarchy.
func dir() (string, error) {
	f, err := os.Open("/proc/self/cgroup")
	if err != nil {
		return "", err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if rel, ok := strings.CutPrefix(scanner.Text(), "0::"); ok {
			return filepath.Join(sysFsCgroup, strings.TrimSpace(rel)), nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("no cgroup v2 unified hierarchy entry (%q) in /proc/self/cgroup", "0::")
}

func readUint(path string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
}

// Memory reads memory.current/memory.max for the calling process's cgroup.
//
// ok is false only when memory.current itself couldn't be read (cgroup dir
// unresolvable, file missing, or malformed) — callers should treat usedBytes
// as meaningless and zero it in that case. limitBytes is nil whenever the
// cgroup has no memory limit set (file contents literally "max") or when
// memory.max couldn't be read for any reason — both cases mean "no known
// limit" to a caller, which is exactly what a null JSON field should mean.
func Memory() (usedBytes uint64, limitBytes *uint64, ok bool) {
	d, err := dir()
	if err != nil {
		return 0, nil, false
	}

	used, err := readUint(filepath.Join(d, "memory.current"))
	if err != nil {
		return 0, nil, false
	}

	if data, err := os.ReadFile(filepath.Join(d, "memory.max")); err == nil {
		limitBytes = parseMemoryMax(string(data))
	}

	return used, limitBytes, true
}

// parseMemoryMax parses memory.max's contents: either the literal "max"
// (no limit, nil) or a byte count.
func parseMemoryMax(content string) *uint64 {
	s := strings.TrimSpace(content)
	if s == "max" {
		return nil
	}
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return nil
	}
	return &v
}

// cpuSample is the cgroup's cumulative CPU time (usage_usec from
// cpu.stat) at a point in time — the whole-container analogue of
// procinfo's per-process cpuSample, same delta-sampling idea one level up
// the hierarchy.
type cpuSample struct {
	usageUsec uint64
	sampledAt time.Time
}

// Sampler holds the previous cpu.stat sample so GET /api/system/resources
// can report a recent-rate cpuPercent (like `docker stats`) instead of a
// lifetime average, exactly like procinfo.Sampler does per-process. Must
// be constructed once and held for the server process's lifetime, not
// reconstructed per request, for the same reason: each request needs to
// diff against the previous request's sample.
type Sampler struct {
	mu   sync.Mutex
	prev cpuSample
}

func NewSampler() *Sampler {
	return &Sampler{}
}

func readCPUStatUsageUsec(path string) (uint64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && fields[0] == "usage_usec" {
			return strconv.ParseUint(fields[1], 10, 64)
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	return 0, fmt.Errorf("usage_usec not found in %s", path)
}

// readCPUMaxCores parses cpu.max, whose contents are either "max <period>"
// (no quota — unlimited, nil) or "<quota> <period>" (both integer
// microseconds, e.g. "200000 100000" = 2.0 cores = quota/period).
func readCPUMaxCores(path string) *float64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	fields := strings.Fields(strings.TrimSpace(string(data)))
	if len(fields) != 2 || fields[0] == "max" {
		return nil
	}
	quota, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return nil
	}
	period, err := strconv.ParseFloat(fields[1], 64)
	if err != nil || period <= 0 {
		return nil
	}
	cores := quota / period
	return &cores
}

// CPU reads cpu.stat's usage_usec and returns the delta-sampled percent
// since this Sampler's previous call, plus the cgroup's core quota read
// fresh from cpu.max each time (nil if unlimited) and runtime.NumCPU() for
// context (unrelated to any cgroup quota — the frontend uses it to show
// "X / Y cores" even when there's no limit).
//
// Normalization choice: when the cgroup has a cpu.max quota, percent is
// computed against that quota — a container pinned to 2 cores reads 100%
// once it's using 2 cores' worth of CPU time, matching what `docker stats`
// shows. When unlimited, percent falls back to percent-of-total-system-
// capacity (numCPU cores), the same convention procinfo.Sampler already
// uses for per-process cpuPercent — kept consistent here since an
// unlimited container can in principle use the whole host, and the
// frontend shouldn't need two different scales depending on whether a
// limit happens to be set.
//
// ok is false only when cpu.stat itself couldn't be read. The very first
// call for this Sampler (no prior sample yet) legitimately reports percent
// 0 with ok true — that's not a failure, just nothing to diff against yet,
// same as procinfo.Sampler's first-sample-per-pid behavior.
func (s *Sampler) CPU() (percent float64, limitCores *float64, numCPU int, ok bool) {
	numCPU = runtime.NumCPU()

	d, err := dir()
	if err != nil {
		return 0, nil, numCPU, false
	}

	usage, err := readCPUStatUsageUsec(filepath.Join(d, "cpu.stat"))
	if err != nil {
		return 0, nil, numCPU, false
	}
	limitCores = readCPUMaxCores(filepath.Join(d, "cpu.max"))

	now := time.Now()
	s.mu.Lock()
	prev := s.prev
	s.prev = cpuSample{usageUsec: usage, sampledAt: now}
	s.mu.Unlock()

	if prev.sampledAt.IsZero() {
		return 0, limitCores, numCPU, true
	}

	elapsed := now.Sub(prev.sampledAt).Seconds()
	if elapsed <= 0 {
		return 0, limitCores, numCPU, true
	}

	delta := int64(usage) - int64(prev.usageUsec)
	if delta < 0 {
		delta = 0
	}

	capacity := float64(numCPU)
	if limitCores != nil && *limitCores > 0 {
		capacity = *limitCores
	}
	if capacity <= 0 {
		capacity = 1
	}

	pct := (float64(delta) / 1e6) / elapsed * 100 / capacity
	switch {
	case pct < 0:
		pct = 0
	case pct > 100:
		pct = 100
	}
	return pct, limitCores, numCPU, true
}

// DiskIOBytes sums rbytes/wbytes across every device line in io.stat for
// the calling process's cgroup. ok is false if the cgroup dir or io.stat
// itself couldn't be read/parsed (e.g. the io controller isn't enabled) —
// callers should treat this as "unavailable", not zero.
func DiskIOBytes() (readBytes, writeBytes uint64, ok bool) {
	d, err := dir()
	if err != nil {
		return 0, 0, false
	}

	f, err := os.Open(filepath.Join(d, "io.stat"))
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	found := false
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		found = true
		// fields[0] is the "<major>:<minor>" device id; the rest are
		// key=value pairs (rbytes/wbytes/rios/wios/dbytes/dios).
		for _, kv := range fields[1:] {
			k, v, ok := strings.Cut(kv, "=")
			if !ok {
				continue
			}
			n, err := strconv.ParseUint(v, 10, 64)
			if err != nil {
				continue
			}
			switch k {
			case "rbytes":
				readBytes += n
			case "wbytes":
				writeBytes += n
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, false
	}
	if !found {
		return 0, 0, false
	}
	return readBytes, writeBytes, true
}

// NetworkIOBytes sums rx/tx bytes across every non-loopback interface in
// /proc/net/dev. ok is false if the file couldn't be read/parsed. This
// container has its own network namespace, so /proc/net/dev is already
// scoped to just this container's interfaces — no cgroup involvement
// needed here, unlike DiskIOBytes/CPU/Memory above.
func NetworkIOBytes() (rxBytes, txBytes uint64, ok bool) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	line := 0
	found := false
	for scanner.Scan() {
		line++
		if line <= 2 {
			// Two header lines before the per-interface rows.
			continue
		}
		text := scanner.Text()
		name, rest, ok := strings.Cut(text, ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "" || name == "lo" {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 16 {
			continue
		}
		rx, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		tx, err := strconv.ParseUint(fields[8], 10, 64)
		if err != nil {
			continue
		}
		rxBytes += rx
		txBytes += tx
		found = true
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, false
	}
	if !found {
		return 0, 0, false
	}
	return rxBytes, txBytes, true
}
