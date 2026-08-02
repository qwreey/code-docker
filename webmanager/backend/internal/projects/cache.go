package projects

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// loadCache reads the on-disk cache. A missing file is not an error — it
// just means "never scanned yet" (zero-value response with a nil
// ScannedAt), which is exactly what NewScanner wants for a first-ever boot.
func loadCache(path string) (ProjectsResponse, error) {
	resp := ProjectsResponse{Roots: []string{}, Projects: []ProjectInfo{}}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return resp, nil
		}
		return resp, err
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return ProjectsResponse{Roots: []string{}, Projects: []ProjectInfo{}}, err
	}
	if resp.Projects == nil {
		resp.Projects = []ProjectInfo{}
	}
	if resp.Roots == nil {
		resp.Roots = []string{}
	}
	return resp, nil
}

// saveCache writes resp atomically: to a temp file in the same directory,
// then os.Rename over the real path, so a reader (or a crash mid-write)
// never sees a partially-written cache file.
func saveCache(path string, resp ProjectsResponse) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(resp, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".projects-cache-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()

	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil {
		os.Remove(tmpPath)
		return writeErr
	}
	if closeErr != nil {
		os.Remove(tmpPath)
		return closeErr
	}

	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}
