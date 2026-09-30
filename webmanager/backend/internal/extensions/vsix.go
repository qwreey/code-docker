package extensions

import (
	"archive/zip"
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	// MaxVSIXBytes caps a marketplace download (after gzip, if any). The
	// largest extensions people install (language packs, C#/C++ toolchains)
	// are well under this.
	MaxVSIXBytes = 200 << 20

	// maxVSIXUnpackedBytes bounds what the zip claims to expand to, since
	// code-server extracts it without a limit of its own.
	maxVSIXUnpackedBytes = 2 << 30

	vsixDownloadTimeout = 3 * time.Minute

	// VSIXInstallTimeout is the most a vsix install (download plus
	// code-server's own install) can take, for callers sizing their own
	// request timeout.
	VSIXInstallTimeout = vsixDownloadTimeout + installTimeout
)

// Sources holds the two registries this package talks to, so tests can point
// them at a local server.
type Sources struct {
	OpenVSXBase     string
	MarketplaceBase string
	HTTP            *http.Client
}

// DefaultSources targets the real open-vsx and MS Marketplace. Redirects are
// followed only within the original host: both hosts answer directly today,
// so a redirect elsewhere is not something to chase blindly.
func DefaultSources() Sources {
	return Sources{
		OpenVSXBase:     "https://" + openVSXHost,
		MarketplaceBase: "https://" + marketplaceHost,
		HTTP: &http.Client{
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 3 || req.URL.Host != via[0].URL.Host {
					return http.ErrUseLastResponse
				}
				return nil
			},
		},
	}
}

// MarketplaceHost is the host a vsix fallback downloads from, for showing to
// the user before they consent.
func MarketplaceHost() string { return marketplaceHost }

// InstallFromMarketplaceVSIX downloads id's latest .vsix from the MS
// Marketplace, checks it really is that extension's package, and installs it
// through code-server's --install-extension. Licensing makes this a
// per-request, user-consented path, never a default: code-server itself only
// installs from open-vsx. Callers must call ValidateID first.
func (s Sources) InstallFromMarketplaceVSIX(ctx context.Context, binPath, userDataDir, extensionsDir, id string) error {
	dir, err := os.MkdirTemp("", "webmanager-vsix-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	path := filepath.Join(dir, id+".vsix")
	dlCtx, cancel := context.WithTimeout(ctx, vsixDownloadTimeout)
	defer cancel()
	if err := s.downloadVSIX(dlCtx, id, path, MaxVSIXBytes); err != nil {
		return err
	}
	if err := VerifyVSIX(path, id); err != nil {
		return err
	}
	return InstallFile(ctx, binPath, userDataDir, extensionsDir, path)
}

// downloadVSIX fetches the latest package for id into path. The Marketplace
// answers this (unofficial but long-stable) vspackage URL with a gzip body
// under Content-Encoding: gzip, which net/http undoes on its own; the magic
// sniff covers a hop that strips the header but leaves the payload gzipped.
func (s Sources) downloadVSIX(ctx context.Context, id, path string, limit int64) error {
	publisher, name := splitID(id)
	endpoint := s.MarketplaceBase + "/_apis/public/gallery/publishers/" + url.PathEscape(publisher) +
		"/vsextensions/" + url.PathEscape(name) + "/latest/vspackage"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("marketplace download: %w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusNotFound:
		return fmt.Errorf("%s is not on the marketplace either", id)
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("marketplace download: HTTP %d", resp.StatusCode)
	case resp.ContentLength > limit:
		return fmt.Errorf("package is larger than the %d MB limit", limit>>20)
	}

	body := bufio.NewReader(resp.Body)
	var src io.Reader = body
	if magic, _ := body.Peek(2); len(magic) == 2 && magic[0] == 0x1f && magic[1] == 0x8b {
		gz, err := gzip.NewReader(body)
		if err != nil {
			return fmt.Errorf("marketplace download: %w", err)
		}
		defer gz.Close()
		src = gz
	}

	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(src, limit+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("marketplace download: %w", err)
	}
	if n > limit {
		return fmt.Errorf("package is larger than the %d MB limit", limit>>20)
	}
	return nil
}

// VerifyVSIX checks that path is a zip carrying a VS Code extension manifest
// whose publisher.name is id (case-insensitive, as both registries are), so a
// wrong or hijacked response doesn't get installed under a name the user
// didn't ask for.
func VerifyVSIX(path, id string) error {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return errors.New("downloaded file is not a valid .vsix (zip) archive")
	}
	defer zr.Close()

	var unpacked uint64
	var pkg *zip.File
	hasManifest := false
	for _, f := range zr.File {
		unpacked += f.UncompressedSize64
		switch f.Name {
		case "extension.vsixmanifest":
			hasManifest = true
		case "extension/package.json":
			pkg = f
		}
	}
	if !hasManifest || pkg == nil {
		return errors.New("downloaded file is not a VS Code extension package")
	}
	if unpacked > maxVSIXUnpackedBytes {
		return errors.New("package expands to an unreasonable size")
	}

	rc, err := pkg.Open()
	if err != nil {
		return errors.New("downloaded package has an unreadable package.json")
	}
	defer rc.Close()
	var meta struct {
		Publisher string `json:"publisher"`
		Name      string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(rc, 4<<20)).Decode(&meta); err != nil {
		return errors.New("downloaded package has an unreadable package.json")
	}
	if !strings.EqualFold(meta.Publisher+"."+meta.Name, id) {
		return fmt.Errorf("downloaded package is %s.%s, not %s", meta.Publisher, meta.Name, id)
	}
	return nil
}

// InstallFile shells out to `code-server --install-extension <path>` for a
// local .vsix. The value is joined to the flag with `=` rather than passed
// after a `--` separator: code-server's argument parser stops treating
// anything after `--` as an option value, which would leave the flag empty
// and the path a file to open. path must be absolute, so it can't be read as
// a flag either way.
func InstallFile(ctx context.Context, binPath, userDataDir, extensionsDir, path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("vsix path must be absolute")
	}
	ctx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()

	args := append(commonArgs(userDataDir, extensionsDir), "--install-extension="+path)
	cmd := exec.CommandContext(ctx, binPath, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return errors.New(msg)
	}
	return nil
}
