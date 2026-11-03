package files

import (
	"mime"
	"os"
	"strings"
	"unicode"
)

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

// AttachmentDisposition is the Content-Disposition for downloading a file
// named name: always attachment, with mime.FormatMediaType doing the quoting
// and RFC 2231 encoding of non-ASCII names, so a quote or backslash in a
// filename can't end the parameter early. Control characters are dropped
// first - a name can come from a client-chosen upload or PUT path.
func AttachmentDisposition(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." || name == "/" {
		name = "download"
	}
	if v := mime.FormatMediaType("attachment", map[string]string{"filename": name}); v != "" {
		return v
	}
	return "attachment"
}

// DownloadCSP goes on every download response next to AttachmentDisposition:
// if a client renders the body anyway, it does so with no script, form or
// same-origin access.
const DownloadCSP = "sandbox"
