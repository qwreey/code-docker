package files

import (
	"os"
	"path/filepath"
	"time"
)

// Entry describes one child of a listed directory.
type Entry struct {
	Name          string    `json:"name"`
	Path          string    `json:"path"`
	IsDir         bool      `json:"isDir"`
	IsSymlink     bool      `json:"isSymlink"`
	SymlinkTarget string    `json:"symlinkTarget,omitempty"`
	Size          int64     `json:"size"`
	Mode          string    `json:"mode"`
	ModTime       time.Time `json:"modTime"`
}

// List returns the immediate children of dirPath (one level, not
// recursive). Hidden dotfiles are included unfiltered — hiding them is a
// pure frontend toggle concern.
//
// Symlink entries are reported as-is (IsSymlink + SymlinkTarget via
// os.Readlink) without being followed; IsDir reflects the link's target
// type (best-effort, for a sensible folder/file icon) when resolvable, but
// browsing "into" a symlink only happens on a subsequent List call whose
// path is that link (which goes through ResolveForAccess and gets
// re-validated then).
func List(root, dirPath string) ([]Entry, error) {
	resolved, err := ResolveForAccess(root, dirPath)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(resolved)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, ErrNotDir
	}

	des, err := os.ReadDir(resolved)
	if err != nil {
		return nil, err
	}

	out := make([]Entry, 0, len(des))
	for _, de := range des {
		childPath := filepath.Join(resolved, de.Name())

		// Lstat (not de.Info(), though they're equivalent here) so a
		// symlink entry is reported as a link rather than silently
		// resolved.
		lst, lerr := os.Lstat(childPath)
		if lerr != nil {
			// Entry vanished between ReadDir and Lstat, or is otherwise
			// unreadable — skip it rather than fail the whole listing
			// (partial failure degrades gracefully, per CLAUDE.md).
			continue
		}

		e := Entry{
			Name:    de.Name(),
			Path:    childPath,
			IsDir:   lst.IsDir(),
			Size:    lst.Size(),
			Mode:    lst.Mode().String(),
			ModTime: lst.ModTime(),
		}
		if lst.Mode()&os.ModeSymlink != 0 {
			e.IsSymlink = true
			e.IsDir = false
			if target, terr := os.Readlink(childPath); terr == nil {
				e.SymlinkTarget = target
			}
			if st, serr := os.Stat(childPath); serr == nil {
				e.IsDir = st.IsDir()
			}
		}
		out = append(out, e)
	}
	return out, nil
}
