// Package webdavshare serves a WebDAV view of the same directory tree the
// file manager exposes (internal/files), so a phone or a desktop file
// browser can mount it natively instead of going through webmanager's own
// REST API. See .claude/backlog/webdav-file-share-plan.md for the design
// this follows.
//
// It does NOT replace the file manager: a browser cannot mount WebDAV, so
// the Files tab still needs its own API. The two share exactly one thing —
// internal/files' root-jail path validation (see jailedDir below).
//
// # Why its own password
//
// Everything else in this container assumes an outer reverse proxy doing
// forward-auth (see root CLAUDE.md's `auth: none` note). WebDAV clients
// (Finder, Windows Explorer, Solid Explorer) speak Basic auth and cannot
// follow an SSO redirect, so this route has to be *excluded* from that
// forward-auth to be usable at all — which means its own password is the
// only thing guarding it. That's why this package carries a separate
// credential rather than reusing internal/authgate's cookie gate, and why
// it is fail-closed: no password configured means the share never serves a
// byte, no matter what `enabled` says.
package webdavshare

import (
	"encoding/json"
	"os"

	"webmanager/internal/atomicfile"
)

// URLPrefix is the path this share is mounted at, both in webmanager's own
// mux and in the nginx locations that proxy to it
// (config/nginx/nginx.default.conf). Not configurable: a WebDAV client
// resolves the <D:href> values in a PROPFIND response against the origin,
// so the prefix the handler strips and the prefix nginx forwards under have
// to be the same string — making it a variable would just create a way for
// the two to drift apart.
const URLPrefix = "/webdav"

// DefaultUsername is used when neither the env var nor the settings file
// names one. WebDAV clients require *some* username for Basic auth, and an
// empty one is rejected by several of them before a request is even sent.
const DefaultUsername = "webdav"

// Settings is the persisted, UI-editable half of the configuration. The
// password is stored only as an argon2id hash (internal/authgate's format);
// the plaintext is shown to the user once, at generation time, and never
// again.
//
// Note that with the default root (/code) a WebDAV client can reach this
// file itself and rewrite its own credential. That is not an escalation —
// the same client could equally rewrite /code/.bashrc, and everything in
// this container runs as root — but it is why narrowing
// WEBMANAGER_WEBDAV_ROOT to a subdirectory is worth doing when the share is
// meant to be a drop box rather than full home access.
type Settings struct {
	Enabled      bool   `json:"enabled"`
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
}

// Load reads settings from path. A missing file means "never configured",
// which is the disabled default rather than an error.
func Load(path string) (Settings, error) {
	var s Settings
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Settings{}, nil
		}
		return Settings{}, err
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return Settings{}, err
	}
	return s, nil
}

// Save writes settings atomically at 0600 — it carries a password hash, so
// it gets the same permissions as the other credential-bearing files
// internal/atomicfile was pulled out for.
func Save(path string, s Settings) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(path, append(data, '\n'), 0o600, 0o700)
}
