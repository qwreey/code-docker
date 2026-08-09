package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"webmanager/internal/gitconfig"
)

func (s *Server) handleGetGitSigning(w http.ResponseWriter, r *http.Request) {
	sig, err := gitconfig.GetSigning(s.cfg.GitConfigPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sig)
}

func (s *Server) handlePutGitSigning(w http.ResponseWriter, r *http.Request) {
	var body gitconfig.Signing
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := gitconfig.SetSigning(s.cfg.GitConfigPath, body); err != nil {
		if errors.Is(err, gitconfig.ErrInvalidSigningMode) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) handleGenerateSSHSigningKey(w http.ResponseWriter, r *http.Request) {
	pubPath, pubKey, err := gitconfig.GenerateSSHSigningKey(s.cfg.SSHSigningKeyPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{
		"publicKeyPath": pubPath,
		"publicKey":     pubKey,
	})
}

// gpgUnavailable writes the 501 response shared by every GPG-backed
// endpoint when gitconfig.ErrGPGNotInstalled bubbles up, since gnupg may not
// be installed yet in whatever container this runs in (only takes effect on
// the container's next rebuild).
func gpgUnavailable(w http.ResponseWriter) {
	writeError(w, http.StatusNotImplemented, gitconfig.ErrGPGNotInstalled.Error())
}

func (s *Server) handleListGPGKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := gitconfig.ListGPGKeys()
	if err != nil {
		if errors.Is(err, gitconfig.ErrGPGNotInstalled) {
			gpgUnavailable(w)
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, keys)
}

func (s *Server) handleGenerateGPGKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Name == "" || body.Email == "" {
		writeError(w, http.StatusBadRequest, "name and email are required")
		return
	}

	key, pub, err := gitconfig.GenerateGPGKey(body.Name, body.Email)
	if err != nil {
		if errors.Is(err, gitconfig.ErrGPGNotInstalled) {
			gpgUnavailable(w)
			return
		}
		if errors.Is(err, gitconfig.ErrInvalidIdentity) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{
		"keyId":     key.KeyID,
		"uid":       key.Uid,
		"publicKey": pub,
	})
}

func (s *Server) handleGetGPGPublicKey(w http.ResponseWriter, r *http.Request) {
	keyID := r.PathValue("keyId")
	pub, err := gitconfig.ExportPublicKey(keyID)
	if err != nil {
		switch {
		case errors.Is(err, gitconfig.ErrGPGNotInstalled):
			gpgUnavailable(w)
		case errors.Is(err, gitconfig.ErrInvalidKeyID):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, gitconfig.ErrGPGKeyNotFound):
			writeError(w, http.StatusNotFound, "gpg key not found")
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"publicKey": pub})
}

func (s *Server) handleDeleteGPGKey(w http.ResponseWriter, r *http.Request) {
	keyID := r.PathValue("keyId")
	if err := gitconfig.DeleteGPGKey(keyID); err != nil {
		switch {
		case errors.Is(err, gitconfig.ErrGPGNotInstalled):
			gpgUnavailable(w)
		case errors.Is(err, gitconfig.ErrInvalidKeyID):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, gitconfig.ErrGPGKeyNotFound):
			writeError(w, http.StatusNotFound, "gpg key not found")
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
