// Package dind talks to the Docker-in-Docker sidecar (code-docker-dind,
// reached via DOCKER_HOST=tcp://dind:2375 — already set in code-docker's
// container environment, see docker-compose.yml) by shelling out to the
// `docker` CLI already baked into the image, rather than a client SDK. See
// webmanager/.claude/dind-plan.md for why: the CLI already emits native JSON
// (--format json for ps/images, and `docker logs` demultiplexes stdout/
// stderr into plain text on its own, unlike the raw Engine API), so a new
// dependency buys nothing.
//
// M1 (list containers/images, tail logs), M2 (start/stop/remove), and M3
// (docker inspect detail view) are all implemented here per the plan doc;
// anything resembling `docker run`/`exec`/`cp` stays deliberately out of
// scope indefinitely.
package dind

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// ErrNotFound is returned when docker reports "No such container"/"No such
// image" for a caller-supplied ID.
var ErrNotFound = errors.New("not found")

// ErrInvalidID is returned by every function here when the caller-supplied
// container/image ID doesn't match idRe. Without this check a value like
// "--privileged" passed as a bare trailing exec.Command arg could be parsed
// by docker as a flag instead of a literal ID (same class of issue as
// gitconfig/gpg.go's fingerprint validation) — docker container/image IDs
// and names are always alphanumeric plus `_.-`, so anything else is rejected
// outright rather than escaped.
var ErrInvalidID = errors.New("id must be a valid docker container/image identifier")

var idRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

// ValidateID reports whether id is safe to pass as a trailing exec.Command
// argument to the docker CLI.
func ValidateID(id string) error {
	if !idRe.MatchString(id) {
		return ErrInvalidID
	}
	return nil
}

// sinceRe matches the only --since formats this package accepts: a bare unix
// timestamp in seconds. RFC3339 support isn't needed yet (the frontend polls
// with the unix second of its last-seen log line) and skipping it keeps
// validation to one simple, obviously-safe pattern.
var sinceRe = regexp.MustCompile(`^[0-9]{1,20}$`)

func ValidateSince(since string) error {
	if !sinceRe.MatchString(since) {
		return errors.New("since must be a unix timestamp in seconds")
	}
	return nil
}

type Container struct {
	ID      string `json:"id"`
	Names   string `json:"names"`
	Image   string `json:"image"`
	Command string `json:"command"`
	State   string `json:"state"`  // running, exited, created, paused, ...
	Status  string `json:"status"` // human-readable, e.g. "Up 3 hours"
	Ports   string `json:"ports"`
	Created string `json:"created"` // human-readable "RunningFor", e.g. "3 hours ago"
}

// dockerPSLine mirrors the fields `docker ps --format json` emits (one JSON
// object per line, verified against docker CLI 29.6.2) that this package
// actually uses.
type dockerPSLine struct {
	ID         string `json:"ID"`
	Names      string `json:"Names"`
	Image      string `json:"Image"`
	Command    string `json:"Command"`
	State      string `json:"State"`
	Status     string `json:"Status"`
	Ports      string `json:"Ports"`
	RunningFor string `json:"RunningFor"`
}

func runDocker(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if strings.Contains(msg, "No such container") || strings.Contains(msg, "No such image") {
			return nil, ErrNotFound
		}
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("docker %s: %s", strings.Join(args, " "), msg)
	}
	return stdout.Bytes(), nil
}

// ListContainers returns every container in the dind daemon (running and
// stopped, matching `docker ps -a`).
func ListContainers(ctx context.Context) ([]Container, error) {
	out, err := runDocker(ctx, "ps", "-a", "--no-trunc", "--format", "json")
	if err != nil {
		return nil, err
	}
	containers := make([]Container, 0)
	for _, line := range bytes.Split(out, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var l dockerPSLine
		if err := json.Unmarshal(line, &l); err != nil {
			continue // skip a malformed line rather than fail the whole list
		}
		containers = append(containers, Container{
			ID:      l.ID,
			Names:   l.Names,
			Image:   l.Image,
			Command: l.Command,
			State:   l.State,
			Status:  l.Status,
			Ports:   l.Ports,
			Created: l.RunningFor,
		})
	}
	return containers, nil
}

type Image struct {
	ID         string `json:"id"`
	Repository string `json:"repository"`
	Tag        string `json:"tag"`
	Size       string `json:"size"`
	Created    string `json:"created"` // human-readable "CreatedSince", e.g. "2 days ago"
}

type dockerImageLine struct {
	ID           string `json:"ID"`
	Repository   string `json:"Repository"`
	Tag          string `json:"Tag"`
	Size         string `json:"Size"`
	CreatedSince string `json:"CreatedSince"`
}

// ListImages returns every image in the dind daemon.
func ListImages(ctx context.Context) ([]Image, error) {
	out, err := runDocker(ctx, "images", "--no-trunc", "--format", "json")
	if err != nil {
		return nil, err
	}
	images := make([]Image, 0)
	for _, line := range bytes.Split(out, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var l dockerImageLine
		if err := json.Unmarshal(line, &l); err != nil {
			continue
		}
		images = append(images, Image{
			ID:         l.ID,
			Repository: l.Repository,
			Tag:        l.Tag,
			Size:       l.Size,
			Created:    l.CreatedSince,
		})
	}
	return images, nil
}

// StartContainer runs `docker start` on id (validated via ValidateID before
// ever reaching exec.Command, same as every other function in this package).
func StartContainer(ctx context.Context, id string) error {
	if err := ValidateID(id); err != nil {
		return err
	}
	_, err := runDocker(ctx, "start", id)
	return err
}

// StopContainer runs `docker stop` on id. This is a graceful stop (SIGTERM
// then SIGKILL after docker's default timeout) — never forced.
func StopContainer(ctx context.Context, id string) error {
	if err := ValidateID(id); err != nil {
		return err
	}
	_, err := runDocker(ctx, "stop", id)
	return err
}

// RemoveContainer runs `docker rm` on id, or `docker rm -f` when force is
// true. force must be an explicit, caller-driven opt-in (see handlers_dind.go
// — it only comes from an explicit query param, never a default) since `-f`
// on a running container kills it without the graceful stop StopContainer
// gives; the frontend confirm dialog is responsible for saying so.
func RemoveContainer(ctx context.Context, id string, force bool) error {
	if err := ValidateID(id); err != nil {
		return err
	}
	args := []string{"rm"}
	if force {
		args = append(args, "-f")
	}
	args = append(args, id)
	_, err := runDocker(ctx, args...)
	return err
}

// Inspect returns the raw `docker inspect` object for id. `docker inspect
// <id>` (a single ID) always returns a JSON array with exactly one element,
// so this unwraps it to a single object — callers (the HTTP handler) get a
// plain object back, not a one-element array.
func Inspect(ctx context.Context, id string) (json.RawMessage, error) {
	if err := ValidateID(id); err != nil {
		return nil, err
	}
	out, err := runDocker(ctx, "inspect", id)
	if err != nil {
		return nil, err
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(out, &arr); err != nil {
		return nil, fmt.Errorf("docker inspect %s: parsing output: %w", id, err)
	}
	if len(arr) == 0 {
		// Shouldn't normally happen — runDocker already translates "No such
		// container" into ErrNotFound above — but be defensive.
		return nil, ErrNotFound
	}
	return arr[0], nil
}

// ContainerLogs returns up to tail lines of combined stdout+stderr for the
// given container. When since is non-empty (validated by ValidateSince) it's
// passed straight through to `docker logs --since`, letting the frontend
// poll for only what's new since its last-seen line instead of re-fetching a
// growing tail — a short-lived process per call rather than a persistent
// --follow subprocess, per the plan doc's recommendation (simpler context-
// cancellation/lifecycle story than an always-on follow).
//
// Unlike ListContainers/ListImages, this doesn't go through runDocker: the
// container's own stdout and stderr both need to be captured (docker logs
// relays each to the CLI's matching stream), so both are pointed at one
// buffer here — runDocker's separate stdout/stderr buffers exist precisely
// to keep docker's own error messages away from command output, which would
// throw away half of a real container's log lines.
func ContainerLogs(ctx context.Context, id string, tail int, since string) (string, error) {
	if err := ValidateID(id); err != nil {
		return "", err
	}
	args := []string{"logs", "--timestamps", "--tail", strconv.Itoa(tail)}
	if since != "" {
		if err := ValidateSince(since); err != nil {
			return "", err
		}
		args = append(args, "--since", since)
	}
	args = append(args, id)

	cmd := exec.CommandContext(ctx, "docker", args...)
	var combined bytes.Buffer
	cmd.Stdout = &combined
	cmd.Stderr = &combined
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(combined.String())
		if strings.Contains(msg, "No such container") {
			return "", ErrNotFound
		}
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("docker %s: %s", strings.Join(args, " "), msg)
	}
	return combined.String(), nil
}
