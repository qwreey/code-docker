package main

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"webmanager/internal/fonts"
)

// defaultFontSeed describes one bundled default font to try downloading on
// first boot (see seedDefaultFonts). Either directURL (a font file as-is)
// or zipURL+zipEntrySuffix (a release zip containing many variants, of
// which only the entry matching the suffix is extracted) is set, never
// both.
type defaultFontSeed struct {
	family         string
	directURL      string
	directExt      string
	zipURL         string
	zipEntrySuffix string
	weight         int
	style          string
}

// defaultFontSeeds are the two fonts from the backlog's own motivating
// example (.claude/backlog/font-manager-plan.md's "기본 시딩 폰트"). URLs
// confirmed live at implementation time — victor-mono ships prebuilt woff2
// directly in its repo (no zip needed); nerd-fonts ships one zip per family
// with Mono/Propo/plain variants inside, of which "...NerdFontMono-Regular.ttf"
// is the fixed-width one wanted for a terminal (matches the backlog's own
// "BlexMono Nerd" naming). If either upstream URL/asset layout changes
// later, this just logs a warning and skips — see seedDefaultFonts.
var defaultFontSeeds = []defaultFontSeed{
	{
		family:    "Victor Mono",
		directURL: "https://raw.githubusercontent.com/rubjo/victor-mono/master/dist/woff2/VictorMono-Regular.woff2",
		directExt: "woff2",
		weight:    400,
		style:     "normal",
	},
	{
		family:         "BlexMono Nerd Font Mono",
		zipURL:         "https://github.com/ryanoasis/nerd-fonts/releases/latest/download/IBMPlexMono.zip",
		zipEntrySuffix: "NerdFontMono-Regular.ttf",
		weight:         400,
		style:          "normal",
	},
}

func defaultFontsSentinelPath(dir string) string {
	return filepath.Join(dir, ".default-fonts-seeded")
}

// seedDefaultFonts runs once per container lifetime (a sentinel file guards
// repeat attempts, so a user who deletes a seeded default font isn't fought
// with it reappearing on the next restart — same "runs once, tracked by a
// marker" shape as user-init.default.sh's migration-version gate). Meant to
// be launched via `go seedDefaultFonts(...)` from main() — every failure
// (network, unexpected asset layout) is logged and skipped, never fatal,
// matching user-init.default.sh's qs_setup curl pattern (root CLAUDE.md:
// "Non-essential setup should degrade gracefully").
func seedDefaultFonts(ctx context.Context, cfg Config) {
	if cfg.SeedDefaultFonts == "false" {
		return
	}
	sentinel := defaultFontsSentinelPath(cfg.FontsDir)
	if _, err := os.Stat(sentinel); err == nil {
		return
	}

	client := &http.Client{Timeout: 60 * time.Second}
	for _, seed := range defaultFontSeeds {
		if err := seedOneDefaultFont(ctx, client, cfg.FontsDir, seed); err != nil {
			log.Printf("seedDefaultFonts: skipping %q: %v", seed.family, err)
			continue
		}
		log.Printf("seedDefaultFonts: seeded %q", seed.family)
	}

	if err := os.MkdirAll(cfg.FontsDir, 0o755); err != nil {
		log.Printf("seedDefaultFonts: couldn't create %s to record completion: %v", cfg.FontsDir, err)
		return
	}
	if err := os.WriteFile(sentinel, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644); err != nil {
		log.Printf("seedDefaultFonts: couldn't write sentinel %s: %v", sentinel, err)
	}
}

func seedOneDefaultFont(ctx context.Context, client *http.Client, dir string, seed defaultFontSeed) error {
	var data []byte
	var ext string
	var err error

	if seed.directURL != "" {
		data, err = fetchURL(ctx, client, seed.directURL)
		ext = seed.directExt
	} else {
		var zipData []byte
		zipData, err = fetchURL(ctx, client, seed.zipURL)
		if err == nil {
			data, err = extractZipEntry(zipData, seed.zipEntrySuffix)
			ext = "ttf"
		}
	}
	if err != nil {
		return err
	}
	if !fonts.AllowedExt(ext) {
		return fmt.Errorf("unexpected extension %q", ext)
	}

	id, err := fonts.RandomID()
	if err != nil {
		return err
	}
	f := fonts.Font{
		ID:               id,
		Family:           seed.family,
		Weight:           seed.weight,
		Style:            seed.style,
		Format:           fonts.FormatForExt(ext),
		Ext:              ext,
		OriginalFilename: seed.family + "." + ext,
		Builtin:          true,
	}

	if err := fonts.SaveFile(dir, f, bytes.NewReader(data)); err != nil {
		return err
	}

	m, err := fonts.Load(dir)
	if err != nil {
		return err
	}
	m.Fonts = append(m.Fonts, f)
	return fonts.Save(dir, m)
}

// maxDefaultFontDownloadBytes caps a single default-font download (font or
// zip). nerd-fonts' per-family release zips bundle every weight/variant
// (Mono/Propo/plain) in one archive and can run ~60 MiB even though only one
// entry inside is ever used (confirmed live: IBMPlexMono.zip is ~61 MiB) —
// 128 MiB leaves real headroom above that while still bounding an
// unexpectedly huge response.
const maxDefaultFontDownloadBytes = 128 * 1024 * 1024

func fetchURL(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d from %s", resp.StatusCode, url)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxDefaultFontDownloadBytes))
}

func extractZipEntry(zipData []byte, suffix string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return nil, err
	}
	for _, file := range zr.File {
		if strings.HasSuffix(file.Name, suffix) {
			rc, err := file.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return io.ReadAll(io.LimitReader(rc, maxDefaultFontDownloadBytes))
		}
	}
	return nil, fmt.Errorf("no entry ending in %q found in zip", suffix)
}
