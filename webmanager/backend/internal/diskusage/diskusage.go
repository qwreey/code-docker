// Package diskusage answers "what's actually using disk space in this
// container" (a small local equivalent of Windows Storage Sense / Samsung's
// storage analyzer) by du-ing each top-level directory under a root path
// (default "/"). This is a different question from GET /api/system/resources'
// disk section, which reports one statfs-based used/total number for a
// single configured mount (SYSTEM_DISK_PATH, default /code, the host bind
// mount) — this package instead breaks the container's own root filesystem
// down by top-level directory, which can be slow (a full recursive walk via
// `du`), so results are cached to disk and only recomputed on an explicit
// trigger, exactly like internal/projects.
package diskusage

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Entry is one top-level directory (or file) directly under Root.
type Entry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
}

// Response is the JSON body of GET/POST .../disk-breakdown, and also the
// on-disk cache file shape.
type Response struct {
	Root       string  `json:"root"`
	Available  bool    `json:"available"`
	Scanning   bool    `json:"scanning"`
	ScannedAt  *string `json:"scannedAt"`
	TotalBytes uint64  `json:"totalBytes"`
	FreeBytes  uint64  `json:"freeBytes"`
	Entries    []Entry `json:"entries"`
}

// pseudoFSTypes are virtual/RAM-backed filesystem types (from /proc/mounts)
// excluded from the breakdown — they're never "disk usage" and walking
// /proc in particular can produce huge, meaningless apparent sizes.
var pseudoFSTypes = map[string]bool{
	"proc": true, "sysfs": true, "devtmpfs": true, "tmpfs": true,
	"devpts": true, "mqueue": true, "cgroup": true, "cgroup2": true,
	"pstore": true, "bpf": true, "autofs": true, "debugfs": true,
	"hugetlbfs": true, "tracefs": true, "configfs": true, "fusectl": true,
	"securityfs": true, "efivarfs": true, "binfmt_misc": true,
}

// Analyzer owns the scan root, the on-disk cache, and "one scan at a time"
// coordination. All exported methods are safe for concurrent use — same
// shape as internal/projects.Scanner.
type Analyzer struct {
	root      string
	cachePath string

	mu       sync.Mutex
	scanning bool
	cache    Response
}

func NewAnalyzer(root, cachePath string) *Analyzer {
	a := &Analyzer{root: root, cachePath: cachePath}
	if cached, err := loadCache(cachePath); err == nil {
		a.cache = cached
	} else {
		a.cache = Response{Root: root, Entries: []Entry{}}
	}
	return a
}

// Snapshot returns the current cached response plus live scanning state.
func (a *Analyzer) Snapshot() Response {
	a.mu.Lock()
	defer a.mu.Unlock()
	entries := make([]Entry, len(a.cache.Entries))
	copy(entries, a.cache.Entries)
	resp := a.cache
	resp.Entries = entries
	resp.Scanning = a.scanning
	return resp
}

// TriggerScan starts a scan in the background unless one is already
// running, in which case it's a no-op — matches
// internal/projects.Scanner.TriggerScan exactly.
func (a *Analyzer) TriggerScan() {
	a.mu.Lock()
	if a.scanning {
		a.mu.Unlock()
		return
	}
	a.scanning = true
	a.mu.Unlock()
	go a.runScan()
}

func (a *Analyzer) runScan() {
	defer func() {
		a.mu.Lock()
		a.scanning = false
		a.mu.Unlock()
	}()

	resp := scan(a.root)

	a.mu.Lock()
	a.cache = resp
	err := saveCache(a.cachePath, resp)
	a.mu.Unlock()
	if err != nil {
		// Best-effort: the in-memory result is still served even if the
		// cache write failed (e.g. read-only filesystem) — just won't
		// survive a restart.
		_ = err
	}
}

func scan(root string) Response {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(root, &stat); err != nil {
		return Response{Root: root, Available: false, Entries: []Entry{}}
	}
	bsize := uint64(stat.Bsize)
	total := stat.Blocks * bsize
	free := stat.Bavail * bsize

	skip := pseudoMountPoints(root)

	entries, err := os.ReadDir(root)
	if err != nil {
		return Response{Root: root, Available: false, Entries: []Entry{}}
	}

	paths := make([]string, 0, len(entries))
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		p := filepath.Join(root, e.Name())
		if skip[p] {
			continue
		}
		paths = append(paths, p)
		names = append(names, e.Name())
	}

	sizes := duSizes(paths)

	result := make([]Entry, 0, len(paths))
	for i, p := range paths {
		result = append(result, Entry{Name: names[i], Path: p, SizeBytes: sizes[p]})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].SizeBytes > result[j].SizeBytes })

	now := time.Now().UTC().Format(time.RFC3339)
	return Response{
		Root:       root,
		Available:  true,
		ScannedAt:  &now,
		TotalBytes: total,
		FreeBytes:  free,
		Entries:    result,
	}
}

// pseudoMountPoints returns the set of direct children of root that are
// themselves mount points for a virtual/RAM-backed filesystem (per
// /proc/mounts) — best-effort: an unreadable /proc/mounts just means
// nothing gets excluded, never a scan failure.
func pseudoMountPoints(root string) map[string]bool {
	skip := map[string]bool{}
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return skip
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 3 {
			continue
		}
		mountPoint, fstype := fields[1], fields[2]
		if filepath.Dir(mountPoint) != filepath.Clean(root) {
			continue // not a direct child of root
		}
		if pseudoFSTypes[fstype] {
			skip[mountPoint] = true
		}
	}
	return skip
}

// duSizes runs a single `du -sb -- <paths...>` and returns each path's
// reported byte size. GNU du's default behavior (verified locally) does not
// follow a symlink given as a command-line argument — it reports just the
// symlink's own tiny size rather than recursing into its target, which
// matters here since Arch's usr-merge makes /bin, /sbin, /lib, /lib64
// symlinks into /usr/*; without that default behavior they'd double-count
// /usr's content. A path missing from the result (du failed on it, e.g. a
// permission error partway through) is simply left out — matches this
// package's general "degrade the specific bit that failed, not the whole
// scan" convention.
func duSizes(paths []string) map[string]int64 {
	sizes := map[string]int64{}
	if len(paths) == 0 {
		return sizes
	}

	args := append([]string{"-sb", "--"}, paths...)
	out, _ := exec.Command("du", args...).Output()
	for _, line := range bytes.Split(out, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		fields := bytes.SplitN(line, []byte("\t"), 2)
		if len(fields) != 2 {
			continue
		}
		n, err := strconv.ParseInt(string(fields[0]), 10, 64)
		if err != nil {
			continue
		}
		sizes[string(fields[1])] = n
	}
	return sizes
}
