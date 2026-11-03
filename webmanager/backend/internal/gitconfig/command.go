package gitconfig

import (
	"context"
	"os/exec"
	"time"
)

// commandTimeout bounds every git, gpg, ssh and ssh-keygen this package
// runs. None should take more than a second or two; a hung gpg-agent or a
// pinentry waiting for a terminal that isn't there would otherwise pin the
// request (and its goroutine) forever.
const commandTimeout = 30 * time.Second

// command is exec.Command with commandTimeout applied. The context's own
// deadline releases it, so callers have nothing to cancel; the AfterFunc
// only makes that explicit.
func command(name string, args ...string) *exec.Cmd {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	time.AfterFunc(commandTimeout, cancel)
	return exec.CommandContext(ctx, name, args...)
}
