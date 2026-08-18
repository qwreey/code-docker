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

	"webmanager/internal/extensions"
	"webmanager/internal/fonts"
)

// defaultFontSeedIDs are recommendations.default.yaml `fonts:` entry ids
// installed automatically on first boot — currently just "jetendard".
// Every other entry in that list is opt-in only, installed on demand via
// the Fonts tab's "추천 폰트" section (POST /api/fonts/install, see
// handleInstallRecommendedFont). Deliberately just ids, not a duplicated
// copy of each font's source URLs — the actual download source lives in
// exactly one place (recommendations.default.yaml), looked up here via
// findRecommendedFont.
var defaultFontSeedIDs = []string{"jetendard"}

// fontDownloadTimeout bounds a single font (or zip) download's HTTP client —
// shared by boot-time seeding and an on-demand recommended-font install
// (handleInstallRecommendedFont), which fetches over the network the same
// way.
const fontDownloadTimeout = 60 * time.Second

func defaultFontsSentinelPath(dir string) string {
	return filepath.Join(dir, ".default-fonts-seeded")
}

// seedDefaultFonts runs once per container lifetime (a sentinel file guards
// repeat attempts) — after this first run, a seeded font is just a normal
// manifest entry: whether the user deletes it or reinstalls it later via
// the Fonts tab's recommendation list is entirely up to them, this function
// never revisits it. Meant to be launched via `go seedDefaultFonts(...)`
// from main() — every failure (network, unexpected asset layout, missing
// recommendations entry) is logged and skipped, never fatal, matching
// user-init.default.sh's qs_setup curl pattern (root CLAUDE.md:
// "Non-essential setup should degrade gracefully").
func seedDefaultFonts(ctx context.Context, cfg Config) {
	if cfg.SeedDefaultFonts == "false" {
		return
	}
	sentinel := defaultFontsSentinelPath(cfg.FontsDir)
	if _, err := os.Stat(sentinel); err == nil {
		return
	}

	recs, err := extensions.LoadRecommendations(cfg.RecommendationsDefaultPath, cfg.RecommendationsOverridePath)
	if err != nil {
		log.Printf("seedDefaultFonts: couldn't load recommendations: %v", err)
	} else {
		client := &http.Client{Timeout: fontDownloadTimeout}
		for _, id := range defaultFontSeedIDs {
			rec := findRecommendedFont(recs, id)
			if rec == nil {
				log.Printf("seedDefaultFonts: skipping %q: not found in recommendations", id)
				continue
			}
			if _, err := installRecommendedFont(ctx, client, cfg.FontsDir, *rec); err != nil {
				log.Printf("seedDefaultFonts: skipping %q: %v", rec.Label, err)
				continue
			}
			log.Printf("seedDefaultFonts: seeded %q", rec.Label)
		}
	}

	if err := os.MkdirAll(cfg.FontsDir, 0o755); err != nil {
		log.Printf("seedDefaultFonts: couldn't create %s to record completion: %v", cfg.FontsDir, err)
		return
	}
	if err := os.WriteFile(sentinel, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644); err != nil {
		log.Printf("seedDefaultFonts: couldn't write sentinel %s: %v", sentinel, err)
	}
}

// findRecommendedFont looks up id among every category in recs.Fonts, or
// nil if no entry matches.
func findRecommendedFont(recs extensions.Recommendations, id string) *extensions.RecommendedFont {
	for _, c := range recs.Fonts {
		for i := range c.Fonts {
			if c.Fonts[i].ID == id {
				return &c.Fonts[i]
			}
		}
	}
	return nil
}

// downloadFontSource fetches one font's binary content, either directly
// (directURL/directExt) or from a release zip (zipURL, extracting the entry
// ending in zipEntrySuffix, always treated as "ttf") — the same either/or
// shape extensions.RecommendedFont uses.
func downloadFontSource(ctx context.Context, client *http.Client, directURL, directExt, zipURL, zipEntrySuffix string) ([]byte, string, error) {
	if directURL != "" {
		data, err := fetchURL(ctx, client, directURL)
		return data, directExt, err
	}
	zipData, err := fetchURL(ctx, client, zipURL)
	if err != nil {
		return nil, "", err
	}
	data, err := extractZipEntry(zipData, zipEntrySuffix)
	return data, "ttf", err
}

// installRecommendedFont downloads rec's font content and adds it to dir's
// manifest as a Builtin entry — shared by seedDefaultFonts (boot-time,
// id-driven via defaultFontSeedIDs) and handleInstallRecommendedFont
// (user-triggered click from the Fonts tab), so both go through identical
// download/extract/save logic.
func installRecommendedFont(ctx context.Context, client *http.Client, dir string, rec extensions.RecommendedFont) (fonts.Font, error) {
	data, ext, err := downloadFontSource(ctx, client, rec.DirectURL, rec.DirectExt, rec.ZipURL, rec.ZipEntrySuffix)
	if err != nil {
		return fonts.Font{}, err
	}
	if !fonts.AllowedExt(ext) {
		return fonts.Font{}, fmt.Errorf("unexpected extension %q", ext)
	}

	id, err := fonts.RandomID()
	if err != nil {
		return fonts.Font{}, err
	}
	f := fonts.Font{
		ID:               id,
		Family:           rec.Label,
		Weight:           rec.Weight,
		Style:            rec.Style,
		Format:           fonts.FormatForExt(ext),
		Ext:              ext,
		OriginalFilename: rec.Label + "." + ext,
		Builtin:          true,
	}

	if err := fonts.SaveFile(dir, f, bytes.NewReader(data)); err != nil {
		return fonts.Font{}, err
	}

	m, err := fonts.Load(dir)
	if err != nil {
		return fonts.Font{}, err
	}
	m.Fonts = append(m.Fonts, f)
	if err := fonts.Save(dir, m); err != nil {
		return fonts.Font{}, err
	}
	return f, nil
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
