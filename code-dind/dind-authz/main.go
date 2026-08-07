// dind-authz is a minimal Docker Engine authorization plugin. It denies
// container-create requests that ask for host-level privilege (Privileged,
// a CapAdd/SecurityOpt/pid-net-ipc-cgroupns=host/device escalation, or a
// bind-mount source outside an explicit allow-list) and allows everything
// else. Policy is a merged set of *.json fragments loaded from one or more
// conf.d-style directories — see policy.go's config struct.
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// authZReq/authZRes mirror Docker's plugin authorization API
// (github.com/docker/docker/pkg/authorization). RequestBody's []byte type
// relies on encoding/json's built-in base64 handling, matching how Docker
// itself encodes the field.
type authZReq struct {
	RequestMethod string `json:"RequestMethod"`
	RequestURI    string `json:"RequestURI"`
	RequestBody   []byte `json:"RequestBody"`
}

type authZRes struct {
	Allow bool   `json:"Allow"`
	Msg   string `json:"Msg,omitempty"`
}

func main() {
	socketPath := flag.String("socket", "/run/docker/plugins/dind-authz.sock", "unix socket to listen on")
	policyDirsFlag := flag.String("policy-dirs", "", "comma-separated list of directories containing *.json policy fragments (merged in sorted-filename order across all dirs, in the order given)")
	flag.Parse()

	cfg := &config{AllowedCaps: map[string]bool{}}
	for _, dir := range strings.Split(*policyDirsFlag, ",") {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		if err := loadPolicyDir(dir, cfg); err != nil {
			log.Fatalf("dind-authz: loading policy dir %s: %v", dir, err)
		}
	}
	log.Printf("dind-authz: loaded policy — %d allowed capabilities, bind prefixes %v", len(cfg.AllowedCaps), cfg.BindAllowPrefixes)

	mux := http.NewServeMux()
	mux.HandleFunc("/Plugin.Activate", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"Implements": []string{"authz"}})
	})
	mux.HandleFunc("/AuthZPlugin.AuthZReq", func(w http.ResponseWriter, r *http.Request) {
		var req authZReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, authZRes{Allow: false, Msg: "dind-authz: malformed request"})
			return
		}
		var allow bool
		var reason string
		switch {
		case isContainersCreate(req.RequestMethod, req.RequestURI):
			allow, reason = evaluate(req.RequestBody, cfg)
		case isVolumesCreate(req.RequestMethod, req.RequestURI):
			allow, reason = evaluateVolumeCreate(req.RequestBody, cfg)
		default:
			allow, reason = true, ""
		}
		if !allow {
			log.Printf("dind-authz: denied %s %s: %s", req.RequestMethod, req.RequestURI, reason)
		}
		writeJSON(w, authZRes{Allow: allow, Msg: reason})
	})
	mux.HandleFunc("/AuthZPlugin.AuthZRes", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, authZRes{Allow: true})
	})

	os.Remove(*socketPath)
	if err := os.MkdirAll(filepath.Dir(*socketPath), 0o755); err != nil {
		log.Fatalf("dind-authz: creating socket dir: %v", err)
	}
	l, err := net.Listen("unix", *socketPath)
	if err != nil {
		log.Fatalf("dind-authz: listening on %s: %v", *socketPath, err)
	}
	log.Printf("dind-authz: listening on %s", *socketPath)
	log.Fatal(http.Serve(l, mux))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/vnd.docker.plugins.v1.1+json")
	json.NewEncoder(w).Encode(v)
}

// loadPolicyDir merges every *.json file in dir (sorted by filename) into
// cfg. A missing directory is not an error — the /code-only DIND_AUTHZ_VOLUME
// directory doesn't exist until seeded, and the plugin should still start
// with just the baked-in default policy in that case.
func loadPolicyDir(dir string, cfg *config) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		var frag config
		if err := json.Unmarshal(data, &frag); err != nil {
			return err
		}
		mergeConfig(cfg, &frag)
	}
	return nil
}
