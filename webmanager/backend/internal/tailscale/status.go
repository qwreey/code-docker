package tailscale

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"sort"
	"time"
)

// statusTimeout bounds every `tailscale status` subprocess call. The
// command reads local daemon state only (no network round-trip expected),
// but a hung/misbehaving daemon socket must never block the webmanager HTTP
// response — same rationale as claudecode.authTimeout.
const statusTimeout = 5 * time.Second

// FindBinary resolves the `tailscale` binary path. override
// (WEBMANAGER_TAILSCALE_BINPATH) takes priority when non-empty; otherwise it
// falls back to a PATH lookup. Either failing (override doesn't exist, or no
// `tailscale` on PATH) means "not installed" — ok is false, not an error,
// mirroring claudecode.FindBinary exactly.
func FindBinary(override string) (path string, ok bool) {
	if override != "" {
		info, err := os.Stat(override)
		if err != nil || info.IsDir() {
			return "", false
		}
		return override, true
	}
	p, err := exec.LookPath("tailscale")
	if err != nil {
		return "", false
	}
	return p, true
}

// PeerInfo is the subset of `tailscale status --json`'s per-node shape
// (used for both Self and each entry of Peer) this package exposes.
type PeerInfo struct {
	HostName     string   `json:"hostName"`
	DNSName      string   `json:"dnsName"`
	TailscaleIPs []string `json:"tailscaleIPs"`
	Relay        string   `json:"relay"`
	Online       bool     `json:"online"`
	Tags         []string `json:"tags"`
	OS           string   `json:"os"`
}

// Status is the subset of `tailscale status --json`'s output this package
// exposes.
type Status struct {
	BackendState string     `json:"backendState"`
	AuthURL      string     `json:"authUrl"`
	TailnetName  string     `json:"tailnetName"`
	Self         *PeerInfo  `json:"self"`
	Peers        []PeerInfo `json:"peers"`
}

// peerInfoRaw mirrors the CLI's actual per-node JSON shape, field-for-field.
type peerInfoRaw struct {
	HostName     string   `json:"HostName"`
	DNSName      string   `json:"DNSName"`
	TailscaleIPs []string `json:"TailscaleIPs"`
	Relay        string   `json:"Relay"`
	Online       bool     `json:"Online"`
	Tags         []string `json:"Tags"`
	OS           string   `json:"OS"`
}

func (r peerInfoRaw) toPeerInfo() PeerInfo {
	return PeerInfo{
		HostName:     r.HostName,
		DNSName:      r.DNSName,
		TailscaleIPs: r.TailscaleIPs,
		Relay:        r.Relay,
		Online:       r.Online,
		Tags:         r.Tags,
		OS:           r.OS,
	}
}

// currentTailnetRaw mirrors the CLI's CurrentTailnet object; nil/absent
// (e.g. logged out) degrades to an empty TailnetName.
type currentTailnetRaw struct {
	Name string `json:"Name"`
}

// statusRaw mirrors `tailscale status --json`'s on-disk schema, limited to
// the fields this package needs. Peer is a map keyed by node ID.
type statusRaw struct {
	BackendState   string                 `json:"BackendState"`
	AuthURL        string                 `json:"AuthURL"`
	CurrentTailnet *currentTailnetRaw     `json:"CurrentTailnet"`
	Self           *peerInfoRaw           `json:"Self"`
	Peer           map[string]peerInfoRaw `json:"Peer"`
}

// GetStatus runs `tailscale status --json` with a bounded timeout, parsing
// the real CLI output shape and flattening the Peer map into a slice sorted
// by HostName (same map-to-sorted-slice technique as mise.ListTools). Any
// exec/parse failure is returned as a plain error for the caller to degrade
// to `available: false` — a tailnet with no config, or `tailscale` not
// running yet, is a completely normal state here, not exceptional.
func GetStatus(ctx context.Context, binPath string) (Status, error) {
	ctx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, binPath, "status", "--json")
	out, err := cmd.Output()
	if err != nil {
		return Status{}, err
	}

	var raw statusRaw
	if err := json.Unmarshal(out, &raw); err != nil {
		return Status{}, err
	}

	var tailnetName string
	if raw.CurrentTailnet != nil {
		tailnetName = raw.CurrentTailnet.Name
	}

	var self *PeerInfo
	if raw.Self != nil {
		s := raw.Self.toPeerInfo()
		self = &s
	}

	ids := make([]string, 0, len(raw.Peer))
	for id := range raw.Peer {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		return raw.Peer[ids[i]].HostName < raw.Peer[ids[j]].HostName
	})

	peers := make([]PeerInfo, 0, len(raw.Peer))
	for _, id := range ids {
		peers = append(peers, raw.Peer[id].toPeerInfo())
	}

	return Status{
		BackendState: raw.BackendState,
		AuthURL:      raw.AuthURL,
		TailnetName:  tailnetName,
		Self:         self,
		Peers:        peers,
	}, nil
}
