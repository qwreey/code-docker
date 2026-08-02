package files

import "os"

// OpenForDownload opens path for streaming download. The caller (HTTP
// handler) is responsible for closing the returned file and for calling
// http.ServeContent with it (which handles Range/If-Modified-Since without
// buffering the whole file in memory).
//
// Directory download (zip) is not implemented — only single-file download,
// per filemanager-plan.md's v1 scope decision.
func OpenForDownload(root, userPath string) (*os.File, os.FileInfo, error) {
	resolved, err := ResolveForAccess(root, userPath)
	if err != nil {
		return nil, nil, err
	}

	info, err := os.Stat(resolved)
	if err != nil {
		return nil, nil, err
	}
	if info.IsDir() {
		return nil, nil, ErrIsDir
	}

	f, err := os.Open(resolved)
	if err != nil {
		return nil, nil, err
	}
	return f, info, nil
}
