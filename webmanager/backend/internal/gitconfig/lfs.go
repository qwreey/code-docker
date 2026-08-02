package gitconfig

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const lfsInstallTimeout = 10 * time.Second

// LFSStatus reports whether the git-lfs binary is on PATH. It doesn't
// inspect gitConfigPath's filter.lfs.* keys — a container built before
// git-lfs was added to build.default.sh has neither the binary nor those
// keys, so "is the binary there" is the more actionable signal for the
// frontend (and it's what InstallLFS itself gates on below).
func LFSStatus(gitConfigPath string) (installed bool) {
	_, err := exec.LookPath("git-lfs")
	return err == nil
}

// InstallLFS runs `git lfs install` (no --system/--local), which registers
// LFS's filters/hooks into $HOME/.gitconfig — the same file gitConfigPath
// points at everywhere else in this package. Requires git-lfs to already be
// on PATH; older containers built before it was added to build.default.sh
// need a rebuild, not a webmanager fix, hence the dedicated error message.
func InstallLFS(gitConfigPath string) error {
	if _, err := exec.LookPath("git-lfs"); err != nil {
		return fmt.Errorf("git-lfs가 설치되어 있지 않습니다. 이미지를 리빌드해야 합니다.")
	}

	ctx, cancel := context.WithTimeout(context.Background(), lfsInstallTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "lfs", "install")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git lfs install: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
