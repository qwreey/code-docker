// Package claudecode wraps the `claude` CLI (Claude Code) and reads its
// `stats-cache.json` cache file, mirroring the internal/tailscale pattern of
// shelling out to the real CLI rather than re-parsing its config files
// wherever the CLI already exposes an equivalent subcommand (see
// webmanager/.claude/claude-plan.md). `claude` being absent, unauthenticated,
// or slow are all normal, expected states here — never an error return that
// would surface as a 5xx to the HTTP layer; every function degrades to a
// nil/zero result instead.
package claudecode

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"time"
)

// authTimeout bounds every `claude` subprocess call. `auth status` can
// involve a network round-trip (session/subscription check), so a slow or
// hung CLI must never block the webmanager HTTP response.
const authTimeout = 5 * time.Second

// statsCacheFileName is the file directly under the Claude config directory
// (CLAUDE_CONFIG_DIR, default /code/.claude) that this package reads.
const statsCacheFileName = "stats-cache.json"

// miseShimPath is mise's shim for the `claude` binary — checked as a last
// resort after override/PATH. webmanager's own supervisord program
// (config/webmanager/webmanager.default.sh) never runs `mise env`, so mise-installed
// tools never land on its process PATH the way they do for code-server (see
// config/code/code-runner.default.sh) — a bare PATH lookup can never see a
// mise-managed claude-code no matter how many times webmanager or
// code-server gets restarted. The shim sidesteps that entirely: it's a
// small mise-dispatch binary that resolves and execs whatever version is
// currently configured (global or project) at invocation time, so it works
// immediately after `mise use -g claude-code@x` with no restart of
// anything. Fixed path rather than derived from WEBMANAGER_MISE_BINPATH,
// same convention as mise.go's own defaultHomeDir: HOME is always /code in
// this image.
const miseShimPath = "/code/.local/share/mise/shims/claude"

// FindBinary resolves the `claude` binary path: override
// (WEBMANAGER_CLAUDE_BINPATH) takes priority when non-empty; otherwise a
// PATH lookup, then miseShimPath above. All three failing (override doesn't
// exist, no `claude` on PATH, no mise shim either) means "not installed" —
// ok is false, not an error, since that's a perfectly normal state for an
// instance that doesn't use Claude Code. Checked fresh on every call (no
// caching), so a `claude-code` installed via mise — from webmanager's own
// install button or from a plain shell — is picked up the moment the
// frontend next asks, not just after some restart.
func FindBinary(override string) (path string, ok bool) {
	if override != "" {
		info, err := os.Stat(override)
		if err != nil || info.IsDir() {
			return "", false
		}
		return override, true
	}
	if p, err := exec.LookPath("claude"); err == nil {
		return p, true
	}
	if info, err := os.Stat(miseShimPath); err == nil && !info.IsDir() {
		return miseShimPath, true
	}
	return "", false
}

// Auth is the subset of `claude auth status --json`'s output this package
// exposes. The real command also returns apiProvider/orgId/orgName, which
// M1 doesn't need.
type Auth struct {
	LoggedIn         bool   `json:"loggedIn"`
	Email            string `json:"email"`
	SubscriptionType string `json:"subscriptionType"`
	AuthMethod       string `json:"authMethod"`
}

// authStatusRaw mirrors the CLI's actual JSON shape, field-for-field.
type authStatusRaw struct {
	LoggedIn         bool   `json:"loggedIn"`
	AuthMethod       string `json:"authMethod"`
	ApiProvider      string `json:"apiProvider"`
	Email            string `json:"email"`
	OrgId            string `json:"orgId"`
	OrgName          string `json:"orgName"`
	SubscriptionType string `json:"subscriptionType"`
}

// GetAuthStatus runs `claude auth status --json` with a bounded timeout.
// Any failure (binary missing/broken, non-zero exit, timeout, unparseable
// output) is returned as an error for the caller to degrade to `auth: null`
// — never surfaced as an HTTP error, since a logged-out or offline state is
// expected, not exceptional.
//
// Verified quirk (claude 2.1.220): the CLI nulls out email/orgId/orgName in
// this command's own output whenever CLAUDE_CONFIG_DIR is present in its
// environment at all — even set to the exact path it would have defaulted
// to — while loggedIn/authMethod/subscriptionType stay correct regardless.
// This subprocess inherits whatever CLAUDE_CONFIG_DIR happens to be in
// webmanager's own environment (not overridden here), so email comes back
// empty only in the less-common case where an operator has explicitly set
// CLAUDE_CONFIG_DIR to relocate ~/.claude — a pre-existing CLI limitation,
// not something this wrapper can paper over.
func GetAuthStatus(ctx context.Context, binPath string) (Auth, error) {
	ctx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, binPath, "auth", "status", "--json")
	out, err := cmd.Output()
	if err != nil {
		return Auth{}, err
	}

	var raw authStatusRaw
	if err := json.Unmarshal(out, &raw); err != nil {
		return Auth{}, err
	}

	return Auth{
		LoggedIn:         raw.LoggedIn,
		Email:            raw.Email,
		SubscriptionType: raw.SubscriptionType,
		AuthMethod:       raw.AuthMethod,
	}, nil
}

// Counts is a session/message pair, used for both the "today" and "week"
// slices of Stats.
type Counts struct {
	SessionCount int `json:"sessionCount"`
	MessageCount int `json:"messageCount"`
}

// Stats is the quick-overview subset of stats-cache.json this package
// exposes, plus the derived Today/Week aggregates (the cache file has no
// pre-computed "week" field — it's a slice of the most recent 7
// dailyActivity entries), plus the raw per-day/per-model arrays M2 needs for
// the heatmap/weekly graph/model-token-usage breakdown.
type Stats struct {
	TotalSessions              int    `json:"totalSessions"`
	TotalMessages              int    `json:"totalMessages"`
	FirstSessionDate           string `json:"firstSessionDate"`
	LongestSessionMessageCount int    `json:"longestSessionMessageCount"`
	LongestSessionDurationMs   int64  `json:"longestSessionDurationMs"`
	Today                      Counts `json:"today"`
	Week                       Counts `json:"week"`

	DailyActivity    []DailyActivity              `json:"dailyActivity"`
	DailyModelTokens []DailyModelTokens           `json:"dailyModelTokens"`
	HourCounts       map[string]int               `json:"hourCounts"`
	ModelUsage       map[string]ModelUsageSummary `json:"modelUsage"`
}

// DailyActivity is one day's worth of activity counts, as recorded in
// stats-cache.json's dailyActivity array (M2: contribution-graph heatmap +
// weekly bar chart).
type DailyActivity struct {
	Date          string `json:"date"`
	MessageCount  int    `json:"messageCount"`
	SessionCount  int    `json:"sessionCount"`
	ToolCallCount int    `json:"toolCallCount"`
}

// DailyModelTokens is one day's token counts broken down by model, as
// recorded in stats-cache.json's dailyModelTokens array.
type DailyModelTokens struct {
	Date          string           `json:"date"`
	TokensByModel map[string]int64 `json:"tokensByModel"`
}

// ModelUsageSummary is the subset of stats-cache.json's per-model
// modelUsage entry this package keeps; the real file has more fields, but
// input/output/cache-read tokens are enough for a per-model usage summary.
type ModelUsageSummary struct {
	InputTokens          int64 `json:"inputTokens"`
	OutputTokens         int64 `json:"outputTokens"`
	CacheReadInputTokens int64 `json:"cacheReadInputTokens"`
}

// dailyActivityRaw mirrors one entry of stats-cache.json's dailyActivity
// array. Date is a plain "YYYY-MM-DD" string (UTC calendar date, per
// claude-plan.md's research), which sorts correctly as a plain string
// comparison — no need to parse it into a time.Time for ordering.
type dailyActivityRaw struct {
	Date          string `json:"date"`
	MessageCount  int    `json:"messageCount"`
	SessionCount  int    `json:"sessionCount"`
	ToolCallCount int    `json:"toolCallCount"`
}

// dailyModelTokensRaw mirrors one entry of stats-cache.json's
// dailyModelTokens array.
type dailyModelTokensRaw struct {
	Date          string           `json:"date"`
	TokensByModel map[string]int64 `json:"tokensByModel"`
}

type longestSessionRaw struct {
	Duration     int64 `json:"duration"`
	MessageCount int   `json:"messageCount"`
}

// statsCacheRaw mirrors stats-cache.json's on-disk schema, limited to the
// fields M1+M2 need. modelUsage entries carry more fields than
// ModelUsageSummary decodes; the rest are ignored.
type statsCacheRaw struct {
	DailyActivity    []dailyActivityRaw           `json:"dailyActivity"`
	DailyModelTokens []dailyModelTokensRaw        `json:"dailyModelTokens"`
	HourCounts       map[string]int               `json:"hourCounts"`
	ModelUsage       map[string]ModelUsageSummary `json:"modelUsage"`
	TotalSessions    int                          `json:"totalSessions"`
	TotalMessages    int                          `json:"totalMessages"`
	LongestSession   longestSessionRaw            `json:"longestSession"`
	FirstSessionDate string                       `json:"firstSessionDate"`
}

// LoadStats reads and parses <configDir>/stats-cache.json, computing
// Today/Week from dailyActivity using the UTC calendar date — consistent
// with internal/logstore's own UTC day-boundary convention, for the same
// reason (avoid TZ-dependent day-boundary drift). A missing file, unreadable
// file, or unparseable JSON are all returned as a plain error for the caller
// to degrade to `stats: null`, independent of whatever happened with auth
// (historical stats can outlive a logout).
func LoadStats(configDir string) (Stats, error) {
	path := filepath.Join(configDir, statsCacheFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		return Stats{}, err
	}

	var raw statsCacheRaw
	if err := json.Unmarshal(data, &raw); err != nil {
		return Stats{}, err
	}

	sorted := make([]dailyActivityRaw, len(raw.DailyActivity))
	copy(sorted, raw.DailyActivity)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Date > sorted[j].Date })

	today := time.Now().UTC().Format("2006-01-02")
	var todayCounts Counts
	for _, d := range raw.DailyActivity {
		if d.Date == today {
			todayCounts = Counts{SessionCount: d.SessionCount, MessageCount: d.MessageCount}
			break
		}
	}

	var weekCounts Counts
	n := len(sorted)
	if n > 7 {
		n = 7
	}
	for _, d := range sorted[:n] {
		weekCounts.SessionCount += d.SessionCount
		weekCounts.MessageCount += d.MessageCount
	}

	dailyActivity := make([]DailyActivity, len(raw.DailyActivity))
	for i, d := range raw.DailyActivity {
		dailyActivity[i] = DailyActivity{
			Date:          d.Date,
			MessageCount:  d.MessageCount,
			SessionCount:  d.SessionCount,
			ToolCallCount: d.ToolCallCount,
		}
	}

	dailyModelTokens := make([]DailyModelTokens, len(raw.DailyModelTokens))
	for i, d := range raw.DailyModelTokens {
		tokensByModel := d.TokensByModel
		if tokensByModel == nil {
			tokensByModel = map[string]int64{}
		}
		dailyModelTokens[i] = DailyModelTokens{Date: d.Date, TokensByModel: tokensByModel}
	}

	hourCounts := raw.HourCounts
	if hourCounts == nil {
		hourCounts = map[string]int{}
	}

	modelUsage := raw.ModelUsage
	if modelUsage == nil {
		modelUsage = map[string]ModelUsageSummary{}
	}

	return Stats{
		TotalSessions:              raw.TotalSessions,
		TotalMessages:              raw.TotalMessages,
		FirstSessionDate:           raw.FirstSessionDate,
		LongestSessionMessageCount: raw.LongestSession.MessageCount,
		LongestSessionDurationMs:   raw.LongestSession.Duration,
		Today:                      todayCounts,
		Week:                       weekCounts,
		DailyActivity:              dailyActivity,
		DailyModelTokens:           dailyModelTokens,
		HourCounts:                 hourCounts,
		ModelUsage:                 modelUsage,
	}, nil
}

// Plugin is one entry of `claude plugin list --json`'s output — installed
// skills/plugins, read-only (M3). Field names/shape verified against
// claude-plan.md's recorded real output.
type Plugin struct {
	ID          string `json:"id"`
	Version     string `json:"version"`
	Scope       string `json:"scope"`
	Enabled     bool   `json:"enabled"`
	InstallPath string `json:"installPath"`
	InstalledAt string `json:"installedAt"`
	LastUpdated string `json:"lastUpdated"`
}

// ListPlugins runs `claude plugin list --json` with a bounded timeout. Any
// failure (binary missing/broken, non-zero exit, timeout, unparseable
// output) degrades to a nil slice with no error surfaced to the HTTP layer —
// an empty/unavailable plugin list is a normal state here, not exceptional,
// matching GetAuthStatus/LoadStats's convention above.
func ListPlugins(ctx context.Context, binPath string) []Plugin {
	ctx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, binPath, "plugin", "list", "--json")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	var plugins []Plugin
	if err := json.Unmarshal(out, &plugins); err != nil {
		return nil
	}

	return plugins
}
