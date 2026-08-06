package tailscale

import (
	"context"
	"encoding/json"
	"os/exec"
	"sort"
	"time"
)

// statusTimeout bounds every `tailscale status` subprocess call. The
// command reads local daemon state only (no network round-trip expected),
// but a hung/misbehaving daemon socket must never block the HTTP response -
// same rationale as state.go's GetState.
const statusTimeout = 5 * time.Second

// PeerInfo is the subset of `tailscale status --json`'s per-node shape
// (used for both Self and each entry of Peer) this package exposes.
type PeerInfo struct {
	HostName     string   `json:"hostName"`
	DNSName      string   `json:"dnsName"`
	TailscaleIPs []string `json:"tailscaleIPs"`
	Relay        string   `json:"relay"`
	// Direct reports whether the active connection to this peer is a
	// direct/P2P link rather than relayed through a DERP server - derived
	// from CurAddr (ipnstate.PeerStatus), which the CLI only populates once
	// a direct path is actually established, not merely attempted. Relay
	// above still shows the home DERP region even when Direct is true (it's
	// the fallback path, not necessarily the one in use), so the two fields
	// answer different questions and both are exposed.
	Direct bool     `json:"direct"`
	Online bool     `json:"online"`
	Tags   []string `json:"tags"`
	OS     string   `json:"os"`
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
	// CurAddr is only non-empty once a direct/P2P path to this peer is
	// actually established - empty means traffic is currently relayed
	// through DERP, regardless of what Relay (the home region) says.
	CurAddr string   `json:"CurAddr"`
	Online  bool     `json:"Online"`
	Tags    []string `json:"Tags"`
	OS      string   `json:"OS"`
}

func (r peerInfoRaw) toPeerInfo() PeerInfo {
	// TailscaleIPs/Tags come back nil (JSON null, not []) whenever the CLI
	// omits the field - Tags in particular is the common case, since ACL
	// tags are opt-in and most peers/self have none. Normalize both to an
	// empty slice so they always marshal as `[]`, not `null`, matching the
	// frontend's non-nullable string[] type.
	ips := r.TailscaleIPs
	if ips == nil {
		ips = []string{}
	}
	tags := r.Tags
	if tags == nil {
		tags = []string{}
	}
	return PeerInfo{
		HostName:     r.HostName,
		DNSName:      r.DNSName,
		TailscaleIPs: ips,
		Relay:        r.Relay,
		Direct:       r.CurAddr != "",
		Online:       r.Online,
		Tags:         tags,
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
// by HostName. Any exec/parse failure is returned as a plain error for the
// caller to degrade to `available: false` — a tailnet with no config, or
// `tailscale` not running yet, is a completely normal state here, not
// exceptional.
func GetStatus(ctx context.Context) (Status, error) {
	ctx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "tailscale", "status", "--json")
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
