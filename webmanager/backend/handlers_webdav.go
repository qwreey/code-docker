// File share (WebDAV) settings — see internal/webdavshare's package doc for
// why this credential is separate from internal/authgate's.
//
// Unlike most settings tabs here, the GET is password-gated too (see
// main.go's route registration). The reason is the trust asymmetry: the
// WebDAV share is meant to be *excluded* from the outer forward-auth, so
// its username is half of the only credential guarding it — there's no
// reason to hand that half to a caller who hasn't cleared webmanager's own
// gate. No file content is exposed either way.
package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"webmanager/internal/webdavshare"
)

func (s *Server) handleGetWebDAV(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.webdav.Status())
}

// Both fields are pointers so an omitted one means "leave it alone" rather
// than the zero value. Without that, a PUT carrying only {"username":...}
// would silently turn the share off, because Go decodes a missing bool as
// false and this handler can't tell that apart from a deliberate false.
type webdavSettingsRequest struct {
	Enabled  *bool   `json:"enabled"`
	Username *string `json:"username"`
}

func (s *Server) handlePutWebDAV(w http.ResponseWriter, r *http.Request) {
	var body webdavSettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Each field is applied only when it actually differs from what's
	// already effective, so a PUT that carries an env-pinned value
	// unchanged (which is exactly what the tab sends back) isn't rejected
	// as an attempted edit — only a real change to a pinned field is.
	current := s.webdav.Status()

	if body.Username != nil && *body.Username != current.Username {
		if _, err := s.webdav.SetUsername(*body.Username); err != nil {
			writeWebDAVError(w, err)
			return
		}
	}
	if body.Enabled != nil && *body.Enabled != current.Enabled {
		if _, err := s.webdav.SetEnabled(*body.Enabled); err != nil {
			writeWebDAVError(w, err)
			return
		}
	}

	writeJSON(w, http.StatusOK, s.webdav.Status())
}

type webdavPasswordRequest struct {
	// Password is the plaintext to hash. An explicit empty string clears the
	// stored password, which makes the share inactive without touching the
	// enabled flag; an omitted field is a malformed request rather than a
	// clear, so a typo in the field name can't wipe the credential.
	Password *string `json:"password"`
}

func (s *Server) handlePutWebDAVPassword(w http.ResponseWriter, r *http.Request) {
	var body webdavPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Password == nil {
		writeError(w, http.StatusBadRequest, "missing \"password\" field")
		return
	}
	if _, err := s.webdav.SetPassword(*body.Password); err != nil {
		writeWebDAVError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.webdav.Status())
}

// writeWebDAVError maps an env-pinned field to 409 (the request was
// well-formed, the server just refuses to let this value be changed from
// here) and everything else to 500.
func writeWebDAVError(w http.ResponseWriter, err error) {
	if errors.Is(err, webdavshare.ErrLocked) {
		writeError(w, http.StatusConflict, "이 값은 환경변수로 고정돼 있어 여기서 바꿀 수 없습니다 (.env.webmanager 참고)")
		return
	}
	writeError(w, http.StatusInternalServerError, err.Error())
}
