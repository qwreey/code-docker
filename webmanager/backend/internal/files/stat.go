package files

import (
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Info is the info-panel payload: permissions, ownership, and timestamps
// for a single path.
type Info struct {
	Name          string `json:"name"`
	Path          string `json:"path"`
	IsDir         bool   `json:"isDir"`
	IsSymlink     bool   `json:"isSymlink"`
	SymlinkTarget string `json:"symlinkTarget,omitempty"`
	Size          int64  `json:"size"`
	Mode          string `json:"mode"`
	ModeOctal     string `json:"modeOctal"`
	Uid           uint32 `json:"uid"`
	Gid           uint32 `json:"gid"`
	Owner         string `json:"owner,omitempty"`
	Group         string `json:"group,omitempty"`

	ModTime    time.Time `json:"modTime"`
	ChangeTime time.Time `json:"changeTime"`

	// CreatedTime/CreatedTimeAvailable follow review.md #9's pattern for
	// distinguishing "couldn't determine" from "genuinely zero" — birth
	// time is best-effort (statx STATX_BTIME, filesystem/kernel dependent)
	// and often unavailable on container overlay filesystems. See
	// filemanager-plan.md's "info 패널" section.
	CreatedTime          *time.Time `json:"createdTime,omitempty"`
	CreatedTimeAvailable bool       `json:"createdTimeAvailable"`
}

// Stat returns permission/ownership/timestamp info for path. path may
// itself be a symlink: the link entry's own IsSymlink/SymlinkTarget are
// reported, but Size/Mode/timestamps etc. describe whatever the link
// resolves to (re-validated against root — see ResolveForAccess), matching
// filemanager-plan.md's "링크를 열 때(stat 포함)는 EvalSymlinks 후 재검증"
// rule.
func Stat(root, userPath string) (Info, error) {
	resolved, err := ResolvePath(root, userPath)
	if err != nil {
		return Info{}, err
	}

	lst, err := os.Lstat(resolved)
	if err != nil {
		return Info{}, err
	}

	target := resolved
	isSymlink := lst.Mode()&os.ModeSymlink != 0
	var symlinkTarget string
	if isSymlink {
		symlinkTarget, _ = os.Readlink(resolved)
		real, rerr := ResolveForAccess(root, userPath)
		if rerr != nil {
			return Info{}, rerr
		}
		target = real
	}

	info, err := os.Stat(target)
	if err != nil {
		return Info{}, err
	}

	out := Info{
		Name:          filepath.Base(resolved),
		Path:          resolved,
		IsDir:         info.IsDir(),
		IsSymlink:     isSymlink,
		SymlinkTarget: symlinkTarget,
		Size:          info.Size(),
		Mode:          info.Mode().String(),
		ModeOctal:     "0" + strconv.FormatUint(uint64(info.Mode().Perm()), 8),
		ModTime:       info.ModTime(),
	}

	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		out.Uid = st.Uid
		out.Gid = st.Gid
		out.ChangeTime = time.Unix(st.Ctim.Sec, st.Ctim.Nsec)
		// Container has only root in practice, but resolving the name
		// costs nothing and is more useful than a bare uid when it does
		// resolve.
		if u, uerr := user.LookupId(strconv.FormatUint(uint64(st.Uid), 10)); uerr == nil {
			out.Owner = u.Username
		}
		if g, gerr := user.LookupGroupId(strconv.FormatUint(uint64(st.Gid), 10)); gerr == nil {
			out.Group = g.Name
		}
	}

	var stx unix.Statx_t
	if serr := unix.Statx(unix.AT_FDCWD, target, 0, unix.STATX_BTIME, &stx); serr == nil && stx.Mask&unix.STATX_BTIME != 0 {
		created := time.Unix(stx.Btime.Sec, int64(stx.Btime.Nsec))
		out.CreatedTime = &created
		out.CreatedTimeAvailable = true
	}

	return out, nil
}
