package projectgit

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// A repository's own config and attributes can name commands for git to
// run: an fsmonitor hook, an external diff or textconv driver, a clean/
// smudge/process filter, a signature-checking gpg.program. Whatever can
// write a project under /code - a container inside dind with it
// bind-mounted, an unpacked archive, a build script - can plant one, and
// these reads run as root the moment the Projects tab is opened, with no
// password. So every git call here runs with the settings below laid over
// every config scope, at command scope (GIT_CONFIG_COUNT, which also
// reaches the git subprocesses git itself starts, e.g. the status check
// inside `worktree remove`).
//
// This is a list of the ways in, so it is only as complete as that list:
// safety_test.go plants each one and checks nothing runs. The read
// commands' own flags carry the rest (gitReadDiffFlags, gitStatusFlags).
var safetyConfig = [][2]string{
	{"core.fsmonitor", "false"},
	// No hook is expected from a read; post-index-change and
	// reference-transaction would otherwise run the repo's own.
	{"core.hooksPath", "/dev/null"},
	{"diff.external", ""},
	// "log"/"diff" would run git inside each submodule, under its config.
	{"diff.submodule", "short"},
	{"status.submoduleSummary", "false"},
	{"log.showSignature", "false"},
	{"core.pager", "cat"},
	{"gc.auto", "0"},
	{"maintenance.auto", "false"},
}

// gitReadDiffFlags go on every diff/show: no external diff or textconv
// driver (both named per path by .gitattributes, so the config above can't
// name them all), and submodules compared by their recorded commit only -
// "dirty" would mean running git inside each one.
var gitReadDiffFlags = []string{"--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty"}

// gitStatusFlags: the same reason for submodules as gitReadDiffFlags.
var gitStatusFlags = []string{"--ignore-submodules=dirty"}

// allowedFilterCommands are the filter commands left in place: exactly what
// `git lfs install` writes. Any other filter driver, from any config scope,
// is switched off - .git/info/attributes can attach a driver to any path
// and no attribute-source option covers that file, so the driver's command
// is what has to go. A repo with such a filter (git-crypt, a custom
// clean/smudge) may show touched-but-unchanged files as modified here.
var allowedFilterCommands = map[string]string{
	"clean":   "git-lfs clean -- %f",
	"smudge":  "git-lfs smudge -- %f",
	"process": "git-lfs filter-process",
}

// maxFilterDrivers bounds how many drivers filtersToDisable switches off one
// by one, so a config with thousands can't grow the environment past what
// exec allows. Past it the call is refused rather than run unguarded.
const maxFilterDrivers = 64

var errTooManyFilters = errors.New("too many git filter drivers configured")

// ErrOutputTooLarge is returned by runGit when git prints more than
// maxOutputBytes.
var ErrOutputTooLarge = errors.New("git output too large")

const (
	// maxOutputBytes bounds what runGit keeps of git's stdout; every caller
	// but the diffs fails past it rather than parse a partial answer.
	maxOutputBytes = 8 << 20
	// maxDiffBytes is what a diff view gets before it's cut: about as much
	// as the browser can still render line by line.
	maxDiffBytes   = 2 << 20
	maxStderrBytes = 64 << 10
)

// gitEnv is the environment for one git call against path: the process's
// own minus anything that sets git config or redirects the repository,
// plus safetyConfig and one entry per filter driver to switch off, read
// from each of filterPaths (a linked worktree can add drivers in its own
// config.worktree).
func gitEnv(ctx context.Context, filterPaths ...string) ([]string, error) {
	pairs := append([][2]string(nil), safetyConfig...)
	for _, p := range filterPaths {
		off, err := filtersToDisable(ctx, p)
		if err != nil {
			return nil, err
		}
		pairs = append(pairs, off...)
	}

	env := baseEnv()
	env = append(env,
		"GIT_OPTIONAL_LOCKS=0", // status must not rewrite the index under a running git
		"GIT_TERMINAL_PROMPT=0",
		"GIT_PAGER=cat",
		"GIT_CONFIG_COUNT="+strconv.Itoa(len(pairs)),
	)
	for i, kv := range pairs {
		n := strconv.Itoa(i)
		env = append(env, "GIT_CONFIG_KEY_"+n+"="+kv[0], "GIT_CONFIG_VALUE_"+n+"="+kv[1])
	}
	return env, nil
}

// baseEnv is os.Environ() without the variables that would add config or
// point git at another repository than the one -C names. The ones that only
// take config away (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL) stay.
func baseEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		switch {
		case name == "GIT_CONFIG", name == "GIT_CONFIG_PARAMETERS", name == "GIT_CONFIG_COUNT",
			strings.HasPrefix(name, "GIT_CONFIG_KEY_"), strings.HasPrefix(name, "GIT_CONFIG_VALUE_"),
			name == "GIT_DIR", name == "GIT_WORK_TREE", name == "GIT_COMMON_DIR",
			name == "GIT_INDEX_FILE", name == "GIT_OBJECT_DIRECTORY",
			name == "GIT_ALTERNATE_OBJECT_DIRECTORIES", name == "GIT_EXTERNAL_DIFF",
			name == "GIT_ATTR_SOURCE":
			continue
		}
		env = append(env, kv)
	}
	return env
}

// filtersToDisable lists every filter driver configured for path, in any
// scope, whose commands aren't all allowedFilterCommands, as overrides that
// blank its commands and clear `required` (an empty required filter would
// fail the call instead). Reading config runs nothing the repo names.
func filtersToDisable(ctx context.Context, path string) ([][2]string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", path, "config", "-z", "--get-regexp", `^filter\.`)
	cmd.Env = baseEnv()
	var stdout bytes.Buffer
	cmd.Stdout = &limitedBuffer{max: maxOutputBytes, buf: &stdout}
	if err := cmd.Run(); err != nil {
		// 1: no filter.* key at all. 128: not a repository, which
		// IsGitRepo reports on its own.
		var exit *exec.ExitError
		if errors.As(err, &exit) && (exit.ExitCode() == 1 || exit.ExitCode() == 128) {
			return nil, nil
		}
		return nil, fmt.Errorf("git config: %w", err)
	}

	unsafe := map[string]bool{}
	var order []string
	for _, entry := range strings.Split(stdout.String(), "\x00") {
		key, value, _ := strings.Cut(entry, "\n")
		rest, ok := strings.CutPrefix(key, "filter.")
		dot := strings.LastIndexByte(rest, '.')
		if !ok || dot < 0 {
			continue
		}
		driver, variable := rest[:dot], rest[dot+1:]
		if _, seen := unsafe[driver]; !seen {
			unsafe[driver] = false
			order = append(order, driver)
		}
		if want, isCommand := allowedFilterCommands[variable]; isCommand && value != want {
			unsafe[driver] = true
		}
	}
	var off [][2]string
	for _, d := range order {
		if !unsafe[d] {
			continue
		}
		if len(off) >= 4*maxFilterDrivers {
			return nil, errTooManyFilters
		}
		off = append(off,
			[2]string{"filter." + d + ".clean", ""},
			[2]string{"filter." + d + ".smudge", ""},
			[2]string{"filter." + d + ".process", ""},
			[2]string{"filter." + d + ".required", "false"},
		)
	}
	return off, nil
}

// limitedBuffer keeps the first max bytes written to it. Past that it
// either drops the rest quietly (drop, for stderr) or calls onFull once (to
// stop the writer) and refuses it.
type limitedBuffer struct {
	buf    *bytes.Buffer
	max    int
	drop   bool
	full   bool
	onFull func()
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	room := l.max - l.buf.Len()
	if len(p) <= room {
		return l.buf.Write(p)
	}
	l.buf.Write(p[:room])
	if l.drop {
		return len(p), nil
	}
	if !l.full {
		l.full = true
		if l.onFull != nil {
			l.onFull()
		}
	}
	return room, ErrOutputTooLarge
}

// gitCall is one git invocation: the repository, the arguments, and the
// options callers other than the plain reads need.
type gitCall struct {
	path string
	args []string
	// maxOut is how much stdout to keep; runGit's default when 0.
	maxOut int
	// truncate returns what fit within maxOut instead of ErrOutputTooLarge.
	truncate bool
	// extraFilterPaths are read for filter drivers besides path.
	extraFilterPaths []string
}

// run executes c with gitTimeout under gitEnv. It reports whether stdout
// was cut at maxOut (only possible with truncate set). On failure the
// error message is git's own stderr (trimmed), not the opaque
// *exec.ExitError, so callers/logs get something actionable.
func (c gitCall) run() (out []byte, truncated bool, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()

	env, err := gitEnv(ctx, append([]string{c.path}, c.extraFilterPaths...)...)
	if err != nil {
		return nil, false, err
	}
	maxOut := c.maxOut
	if maxOut == 0 {
		maxOut = maxOutputBytes
	}

	full := append([]string{"--no-pager", "-C", c.path}, c.args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = env
	var stdout, stderr bytes.Buffer
	outW := &limitedBuffer{buf: &stdout, max: maxOut, onFull: cancel}
	cmd.Stdout = outW
	cmd.Stderr = &limitedBuffer{buf: &stderr, max: maxStderrBytes, drop: true}
	runErr := cmd.Run()
	if outW.full {
		if !c.truncate {
			return nil, false, fmt.Errorf("git %s: %w", strings.Join(c.args, " "), ErrOutputTooLarge)
		}
		b := stdout.Bytes()
		// Cut back to the last whole line, so neither a diff line nor a
		// UTF-8 sequence is left half-printed.
		if i := bytes.LastIndexByte(b, '\n'); i >= 0 {
			b = b[:i+1]
		}
		return b, true, nil
	}
	if runErr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = runErr.Error()
		}
		return stdout.Bytes(), false, fmt.Errorf("git %s: %s", strings.Join(c.args, " "), msg)
	}
	return stdout.Bytes(), false, nil
}
