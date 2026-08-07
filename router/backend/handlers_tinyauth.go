// Per-user tinyauth credential CRUD (see internal/tinyauthusers) - replaces
// hand-editing the single TINYAUTH_AUTH_USERS env var with individual
// add/delete, backed by a file router-manager owns. Every add/delete
// rewrites internal/tinyauthusers.EnvFilePath and restarts the tinyauth
// supervisord program (same restartSupervisorProgram helper
// handlers_tailscale.go's restartTailscaleForward/restartTailscalePublish
// use) so the change actually takes effect - tinyauth only reads its env var
// once at process start.
package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"

	"router/internal/tinyauthusers"
)

// tinyauthUserResponse is what the list endpoint returns - name only, the
// hash never leaves this process.
type tinyauthUserResponse struct {
	Name string `json:"name"`
}

type tinyauthUsersListResponse struct {
	Pinned bool                   `json:"pinned"`
	Users  []tinyauthUserResponse `json:"users"`
}

// tinyauthPinned reports whether the real TINYAUTH_AUTH_USERS env var is set
// - router-manager shares the container's environment with the tinyauth
// supervisord program (no per-program `environment=` override in
// router/config/supervisord.d/tinyauth.conf), so this sees the exact same
// value tinyauth.default.sh would honor over the file-backed store.
func tinyauthPinned() bool {
	return os.Getenv("TINYAUTH_AUTH_USERS") != ""
}

func applyTinyauthUsers(w http.ResponseWriter, r *http.Request) bool {
	users, err := tinyauthusers.ListUsers(tinyauthusers.StorePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return false
	}
	if err := tinyauthusers.RenderEnvFile(tinyauthusers.EnvFilePath, users); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return false
	}
	if err := restartSupervisorProgram(r.Context(), "tinyauth"); err != nil {
		writeSupervisorErr(w, err)
		return false
	}
	return true
}

func handleListTinyauthUsers(w http.ResponseWriter, r *http.Request) {
	users, err := tinyauthusers.ListUsers(tinyauthusers.StorePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := make([]tinyauthUserResponse, len(users))
	for i, u := range users {
		resp[i] = tinyauthUserResponse{Name: u.Name}
	}
	writeJSON(w, http.StatusOK, tinyauthUsersListResponse{Pinned: tinyauthPinned(), Users: resp})
}

func handleAddTinyauthUser(w http.ResponseWriter, r *http.Request) {
	if tinyauthPinned() {
		writeError(w, http.StatusConflict, "TINYAUTH_AUTH_USERS 환경변수로 고정되어 있어 변경할 수 없습니다")
		return
	}
	var body struct {
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := tinyauthusers.AddUser(tinyauthusers.StorePath, body.Name, body.Password); err != nil {
		if errors.Is(err, tinyauthusers.ErrUserExists) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !applyTinyauthUsers(w, r) {
		return
	}
	writeJSON(w, http.StatusCreated, tinyauthUserResponse{Name: body.Name})
}

func handleDeleteTinyauthUser(w http.ResponseWriter, r *http.Request) {
	if tinyauthPinned() {
		writeError(w, http.StatusConflict, "TINYAUTH_AUTH_USERS 환경변수로 고정되어 있어 변경할 수 없습니다")
		return
	}
	name := r.PathValue("name")
	if err := tinyauthusers.DeleteUser(tinyauthusers.StorePath, name); err != nil {
		if errors.Is(err, tinyauthusers.ErrUserNotFound) {
			writeError(w, http.StatusNotFound, "user not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !applyTinyauthUsers(w, r) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
