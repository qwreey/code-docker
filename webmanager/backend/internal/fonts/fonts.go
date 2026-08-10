// Package fonts persists user-uploaded font files (for the web terminal and
// code-server's terminal/editor, see webmanager CLAUDE.md) and generates the
// @font-face CSS that exposes them to the browser. Same "single JSON blob,
// atomic temp-file+rename write" idiom as internal/terminalsettings, but the
// manifest lives alongside the actual font binaries in one directory (see
// Load/Save) rather than under webmanager's own settings path, since
// code-server's own patched CSS (config/code/code-patch/fonts.default.css)
// needs a stable place to point at regardless of webmanager's internal
// layout.
package fonts

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Font is one uploaded font file's metadata. ID is a random hex string used
// as both the manifest key and the on-disk filename (Ext appended) — never
// derived from the user-supplied original filename, so uploads never
// collide and never need path-traversal sanitization of that name (see
// OriginalFilename below, which is display-only).
type Font struct {
	ID     string `json:"id"`
	Family string `json:"family"`
	Weight int    `json:"weight"`
	// Style is "normal", "italic", or "oblique".
	Style string `json:"style"`
	// Format is the @font-face format() token ("truetype", "opentype",
	// "woff", "woff2"), derived from Ext at upload time.
	Format string `json:"format"`
	// Ext is the stored file's extension (without the dot) — also the
	// on-disk filename's suffix (see StoredPath).
	Ext string `json:"ext"`
	// OriginalFilename is the name the user uploaded, kept only for
	// display in the UI — never used to build a filesystem path.
	OriginalFilename string `json:"originalFilename"`
	// Builtin marks a font seeded by code-docker itself at first boot
	// (see cmd/seeddefaults.go) rather than uploaded by the user —
	// display-only distinction, deletable like any other entry.
	Builtin bool `json:"builtin"`
}

// Manifest is the full persisted blob — the list of every known font.
type Manifest struct {
	Fonts []Font `json:"fonts"`
}

func empty() Manifest {
	return Manifest{Fonts: []Font{}}
}

func manifestPath(dir string) string {
	return filepath.Join(dir, "manifest.json")
}

// StoredPath is where a font's binary content lives on disk.
func StoredPath(dir string, f Font) string {
	return filepath.Join(dir, f.ID+"."+f.Ext)
}

// Load reads the manifest from dir. A missing file just means "no fonts
// uploaded yet", returning an empty manifest (not an error).
func Load(dir string) (Manifest, error) {
	m := empty()
	data, err := os.ReadFile(manifestPath(dir))
	if err != nil {
		if os.IsNotExist(err) {
			return m, nil
		}
		return m, err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return empty(), err
	}
	if m.Fonts == nil {
		m.Fonts = []Font{}
	}
	return m, nil
}

// Save writes m atomically (temp file + os.Rename in the same directory),
// same idiom as internal/terminalsettings.Save.
func Save(dir string, m Manifest) error {
	if m.Fonts == nil {
		m.Fonts = []Font{}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".fonts-manifest-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()

	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil {
		os.Remove(tmpPath)
		return writeErr
	}
	if closeErr != nil {
		os.Remove(tmpPath)
		return closeErr
	}

	if err := os.Rename(tmpPath, manifestPath(dir)); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}

// allowedExts is the upload whitelist — anything else is rejected outright
// rather than sniffed/converted (root CLAUDE.md: validate user input that
// flows into a file path before use).
var allowedExts = map[string]string{
	"ttf":   "truetype",
	"otf":   "opentype",
	"woff":  "woff",
	"woff2": "woff2",
}

// AllowedExt reports whether ext (no leading dot, any case already
// lowercased by the caller) is an accepted font file type.
func AllowedExt(ext string) bool {
	_, ok := allowedExts[ext]
	return ok
}

// FormatForExt maps a stored extension to its @font-face format() token.
// Only meaningful for an ext that already passed AllowedExt.
func FormatForExt(ext string) string {
	return allowedExts[ext]
}

// MIME maps a stored extension to the Content-Type used when serving the
// raw font bytes.
func MIME(ext string) string {
	switch ext {
	case "ttf":
		return "font/ttf"
	case "otf":
		return "font/otf"
	case "woff":
		return "font/woff"
	case "woff2":
		return "font/woff2"
	default:
		return "application/octet-stream"
	}
}

// RandomID generates a fresh, filename-safe, collision-resistant id for a
// newly uploaded font.
func RandomID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// SaveFile writes r's content to f's stored path under dir.
func SaveFile(dir string, f Font, r io.Reader) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	dest := StoredPath(dir, f)
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, r)
	closeErr := out.Close()
	if copyErr != nil {
		os.Remove(dest)
		return copyErr
	}
	if closeErr != nil {
		os.Remove(dest)
		return closeErr
	}
	return nil
}

// DeleteFile removes f's stored binary. Missing-file is not an error —
// deleting a manifest entry whose file is already gone should still succeed.
func DeleteFile(dir string, f Font) error {
	err := os.Remove(StoredPath(dir, f))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// fileURLPrefix is where GET /api/fonts/files/{id} is reachable from
// *any* page on this container — code-docker/webmanager merges code-server
// (/) and webmanager (/manager) onto one nginx origin (see root CLAUDE.md's
// "single-origin merge"), so a fixed /manager/... absolute path resolves
// correctly whether this CSS is loaded by webmanager's own page or, via
// config/code/code-patch/fonts.default.css's @import, by code-server's.
const fileURLPrefix = "/manager/api/fonts/files/"

// GenerateCSS builds the @font-face rules for every font in fonts. This is
// the entire content of GET /api/fonts/css — deliberately just font
// definitions, no forced-application overrides: code-server already lets a
// user set editor.fontFamily/terminal.integrated.fontFamily themselves, and
// once the name is defined here the browser matches it automatically (see
// webmanager CLAUDE.md's Fonts tab notes).
func GenerateCSS(fonts []Font) string {
	var b strings.Builder
	for _, f := range fonts {
		style := f.Style
		if style == "" {
			style = "normal"
		}
		weight := f.Weight
		if weight == 0 {
			weight = 400
		}
		fmt.Fprintf(&b, "@font-face {\n  font-family: '%s';\n  src: url('%s%s') format('%s');\n  font-weight: %d;\n  font-style: %s;\n}\n",
			cssEscape(f.Family), fileURLPrefix, f.ID, f.Format, weight, style)
	}
	return b.String()
}

// cssEscape escapes a single-quote inside a font-family name so it can't
// break out of the CSS string literal it's interpolated into above.
func cssEscape(s string) string {
	return strings.ReplaceAll(s, "'", "\\'")
}
