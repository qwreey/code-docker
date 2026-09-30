package extensions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// Where a pasted extension reference pointed. Only used for display and to
// decide what to tell the user; every source ends up as the same
// publisher.name id before it reaches an exec or a URL.
const (
	SourceMarketplace = "marketplace"
	SourceOpenVSX     = "open-vsx"
	SourceID          = "id"
)

const (
	marketplaceHost = "marketplace.visualstudio.com"
	openVSXHost     = "open-vsx.org"

	// MaxInputLen bounds the pasted text: a page of prose around a link is
	// fine, a megabyte is a mistake.
	MaxInputLen = 4096
)

// ErrNoExtension is returned by ParseInput when the text holds neither a
// recognized registry URL nor a bare id.
var ErrNoExtension = errors.New("no marketplace URL or publisher.name id found")

// Parsed is the extension a pasted text refers to.
type Parsed struct {
	Source string `json:"source"`
	ID     string `json:"id"`
}

var urlInTextRe = regexp.MustCompile("https?://[^\\s<>\"'`]+")

// ParseInput finds the extension a pasted text refers to: the whole text as a
// bare `publisher.name`, or the first marketplace / open-vsx item URL inside
// it (a link pasted with a title or a sentence around it is the common case).
// Any id it returns has passed ValidateID. A recognized URL whose id fails
// validation yields ErrInvalidID rather than ErrNoExtension, so the user
// hears "that link is malformed" instead of "no link found".
func ParseInput(text string) (Parsed, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return Parsed{}, ErrNoExtension
	}
	if len(text) > MaxInputLen {
		return Parsed{}, fmt.Errorf("text is longer than %d characters", MaxInputLen)
	}
	if ValidateID(text) == nil {
		return Parsed{Source: SourceID, ID: text}, nil
	}

	invalid := false
	for _, raw := range urlInTextRe.FindAllString(text, -1) {
		// A link at the end of a sentence or inside parentheses drags the
		// punctuation along.
		raw = strings.TrimRight(raw, ".,;:!?)]}")
		u, err := url.Parse(raw)
		if err != nil {
			continue
		}
		source, id := "", ""
		switch strings.ToLower(u.Hostname()) {
		case marketplaceHost:
			if strings.TrimSuffix(u.Path, "/") == "/items" {
				source, id = SourceMarketplace, u.Query().Get("itemName")
			}
		case openVSXHost:
			// /extension/<publisher>/<name>[/<version>]. Split the escaped
			// path so an encoded slash stays inside its segment instead of
			// shifting the segments.
			if seg := strings.Split(strings.Trim(u.EscapedPath(), "/"), "/"); len(seg) >= 3 && seg[0] == "extension" {
				publisher, err1 := url.PathUnescape(seg[1])
				name, err2 := url.PathUnescape(seg[2])
				if err1 == nil && err2 == nil {
					source, id = SourceOpenVSX, publisher+"."+name
				}
			}
		}
		if source == "" {
			continue
		}
		if ValidateID(id) != nil {
			invalid = true
			continue
		}
		return Parsed{Source: source, ID: id}, nil
	}
	if invalid {
		return Parsed{}, ErrInvalidID
	}
	return Parsed{}, ErrNoExtension
}

// OpenVSXInfo is what open-vsx knows about an extension id.
type OpenVSXInfo struct {
	Found       bool   `json:"found"`
	Label       string `json:"label,omitempty"`
	Description string `json:"description,omitempty"`
	Homepage    string `json:"homepage,omitempty"`
	Version     string `json:"version,omitempty"`
}

// splitID splits a validated id into publisher and name.
func splitID(id string) (publisher, name string) {
	publisher, name, _ = strings.Cut(id, ".")
	return publisher, name
}

// LookupOpenVSX asks open-vsx's public API whether id exists. A missing
// extension is Found=false, not an error; an unreachable or misbehaving
// registry is an error, so it isn't mistaken for "not there" (which would
// push the user toward the vsix fallback). Callers must call ValidateID first.
func (s Sources) LookupOpenVSX(ctx context.Context, id string) (OpenVSXInfo, error) {
	publisher, name := splitID(id)
	endpoint := s.OpenVSXBase + "/api/" + url.PathEscape(publisher) + "/" + url.PathEscape(name)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return OpenVSXInfo{}, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return OpenVSXInfo{}, fmt.Errorf("open-vsx lookup: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return OpenVSXInfo{Found: false}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return OpenVSXInfo{}, fmt.Errorf("open-vsx lookup: HTTP %d", resp.StatusCode)
	}

	// A popular extension's metadata lists every published version, so this is
	// well past a few KB - but bounded.
	var meta struct {
		Error       string `json:"error"`
		DisplayName string `json:"displayName"`
		Description string `json:"description"`
		Homepage    string `json:"homepage"`
		Version     string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&meta); err != nil {
		return OpenVSXInfo{}, fmt.Errorf("open-vsx lookup: unreadable response: %w", err)
	}
	if meta.Error != "" {
		return OpenVSXInfo{Found: false}, nil
	}
	return OpenVSXInfo{
		Found:       true,
		Label:       meta.DisplayName,
		Description: meta.Description,
		Homepage:    httpURLOrEmpty(meta.Homepage),
		Version:     meta.Version,
	}, nil
}

// httpURLOrEmpty drops anything that isn't a plain http(s) URL; the value
// comes from an extension author and ends up in an href.
func httpURLOrEmpty(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return raw
}
