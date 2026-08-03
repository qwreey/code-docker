package diskusage

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// loadCache reads the on-disk cache. A missing file just means "never
// scanned yet" — matches internal/projects/cache.go's loadCache exactly.
func loadCache(path string) (Response, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Response{Entries: []Entry{}}, nil
		}
		return Response{Entries: []Entry{}}, err
	}
	var resp Response
	if err := json.Unmarshal(data, &resp); err != nil {
		return Response{Entries: []Entry{}}, err
	}
	if resp.Entries == nil {
		resp.Entries = []Entry{}
	}
	return resp, nil
}

// saveCache writes resp atomically (temp file + rename) — same pattern as
// internal/projects/cache.go's saveCache.
func saveCache(path string, resp Response) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(resp, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".disk-breakdown-cache-*.tmp")
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
