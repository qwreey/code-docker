package projects

import (
	"os"
	"path/filepath"
	"time"
)

// scanProject walks a single project's tree, computing total size,
// reclaimable subtrees, and last-modified in one pass.
func scanProject(root, path string, patterns map[string]struct{}, oldDays int) ProjectInfo {
	baseline := time.Time{}
	if info, err := os.Lstat(path); err == nil {
		baseline = info.ModTime()
	}

	size, lastMod, reclaimable := scanDir(path, patterns)
	if baseline.After(lastMod) {
		lastMod = baseline
	}
	if reclaimable == nil {
		reclaimable = []ReclaimableEntry{}
	}

	var reclaimableSize int64
	for _, r := range reclaimable {
		reclaimableSize += r.SizeBytes
	}

	now := time.Now().UTC()
	stale := lastMod.Before(now.AddDate(0, 0, -oldDays))

	return ProjectInfo{
		Root:                 root,
		Name:                 filepath.Base(path),
		Path:                 path,
		TotalSizeBytes:       size,
		ReclaimableSizeBytes: reclaimableSize,
		Reclaimable:          reclaimable,
		LastModified:         lastMod.Format(time.RFC3339),
		Stale:                stale,
		TechStack:            detectTechStack(path),
		ScannedAt:            now.Format(time.RFC3339),
	}
}

// scanDir recursively sums size and finds the max mtime across every file
// in dir, skipping (and not recursing into) .git and any directory whose
// basename matches a reclaimable pattern — those are recorded as a
// ReclaimableEntry with just their subtree size instead. Symlinks are never
// followed (os.Lstat, matching du's default) — only their own directory
// entry size is counted, avoiding both cycles and counting content outside
// the project tree.
func scanDir(dir string, patterns map[string]struct{}) (size int64, lastMod time.Time, reclaimable []ReclaimableEntry) {
	f, err := os.Open(dir)
	if err != nil {
		return 0, time.Time{}, nil
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return 0, time.Time{}, nil
	}

	for _, entry := range entries {
		name := entry.Name()
		path := filepath.Join(dir, name)
		info, err := os.Lstat(path)
		if err != nil {
			continue
		}

		if info.Mode()&os.ModeSymlink != 0 {
			size += info.Size()
			continue
		}

		if info.IsDir() {
			if name == ".git" {
				continue
			}
			if _, ok := patterns[name]; ok {
				sub := dirSize(path)
				size += sub
				reclaimable = append(reclaimable, ReclaimableEntry{Pattern: name, Path: path, SizeBytes: sub})
				continue
			}
			subSize, subMod, subReclaimable := scanDir(path, patterns)
			size += subSize
			if subMod.After(lastMod) {
				lastMod = subMod
			}
			reclaimable = append(reclaimable, subReclaimable...)
			continue
		}

		size += info.Size()
		if info.ModTime().After(lastMod) {
			lastMod = info.ModTime()
		}
	}

	return size, lastMod, reclaimable
}

// dirSize sums a subtree's size without tracking mtime or nested
// reclaimable entries — used for a subtree already matched as reclaimable,
// where only the total byte count is needed.
func dirSize(dir string) int64 {
	f, err := os.Open(dir)
	if err != nil {
		return 0
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return 0
	}

	var total int64
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			total += info.Size()
			continue
		}
		if info.IsDir() {
			total += dirSize(path)
			continue
		}
		total += info.Size()
	}
	return total
}

// techStackMarkers is checked in order so ProjectInfo.TechStack is
// deterministic when multiple markers match (e.g. a monorepo with both
// package.json and Cargo.toml).
var techStackMarkers = []struct {
	file  string
	badge string
}{
	{"package.json", "Node.js"},
	{"Cargo.toml", "Rust"},
	{"pyproject.toml", "Python"},
	{"requirements.txt", "Python"},
	{"go.mod", "Go"},
	{"build.gradle", "Gradle/Android"},
	{"build.gradle.kts", "Gradle/Android"},
	{"pom.xml", "Maven"},
	{"composer.json", "PHP"},
}

// detectTechStack only checks the project's top-level directory for marker
// files, not a deep search.
func detectTechStack(dir string) []string {
	result := []string{}
	seen := make(map[string]bool, len(techStackMarkers))
	for _, m := range techStackMarkers {
		if seen[m.badge] {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, m.file)); err != nil {
			continue
		}
		result = append(result, m.badge)
		seen[m.badge] = true
	}
	return result
}
