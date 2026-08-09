package dns

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

var ErrEmptyDomain = errors.New("domain is required")
var ErrInvalidQueryType = errors.New("unsupported record type")

// queryTypes mirrors the record types `dig` accepts as a plain type
// argument - kept as an allowlist (rather than passing the user's string
// straight through) purely so a typo/garbage value fails with a clear 400
// instead of `dig` silently treating it as a hostname.
var queryTypes = map[string]bool{
	"A": true, "AAAA": true, "CNAME": true, "MX": true, "TXT": true,
	"NS": true, "SOA": true, "PTR": true, "SRV": true, "ANY": true,
}

// allTypes is what recordType "ALL" expands to - every individually
// selectable type except PTR/ANY. Deliberately not just a single
// `dig <domain> ANY`: many resolvers (dnsmasq included) give ANY a
// minimal/incomplete response per RFC 8482 rather than everything they'd
// answer individually, which is exactly the gap a debugging tool shouldn't
// have. PTR is excluded: it needs a reverse (in-addr.arpa/ip6.arpa) name,
// not the forward domain every other type here queries, so bundling it in
// would silently fail for every normal domain.
var allTypes = []string{"A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "SRV"}

// QueryResult is POST /api/dns/query's response. Output is `dig`'s raw text
// (answer section + the trailing stats/timing footer) rather than a parsed
// structure - this is a debugging tool (see
// router/.claude/net-auth-expansion-plan.md's "DNS dig형 조회 도구"), and
// dig's own output already carries everything a "like dig" view needs
// (record type/TTL/value, query time, which server answered).
type QueryResult struct {
	Domain     string `json:"domain"`
	Type       string `json:"type"`
	DurationMs int64  `json:"durationMs"`
	Output     string `json:"output"`
}

// Query shells out to `dig @127.0.0.1 <domain> <type>` - i.e. against this
// container's own dnsmasq, not some arbitrary external resolver - so the
// result reflects exactly what code-docker/dind would get back from it
// (blocklist 0.0.0.0 answers, custom-hosts entries, cache hits/misses,
// upstream failures). Cache *inspection*/clearing was explicitly scoped out
// by the request that designed this (too tied to dnsmasq/host internals) -
// dig's own reported query time is the only cache-adjacent signal exposed.
func Query(ctx context.Context, domain, recordType string) (QueryResult, error) {
	domain = strings.TrimSpace(domain)
	if domain == "" {
		return QueryResult{}, ErrEmptyDomain
	}
	recordType = strings.ToUpper(strings.TrimSpace(recordType))
	if recordType == "" {
		recordType = "A"
	}
	if recordType != "ALL" && !queryTypes[recordType] {
		return QueryResult{}, ErrInvalidQueryType
	}

	if _, err := exec.LookPath("dig"); err != nil {
		return QueryResult{}, fmt.Errorf("dig binary not available: %w", err)
	}

	args := []string{"+noall", "+answer", "+comments", "+stats", "@127.0.0.1"}
	if recordType == "ALL" {
		// Repeating "<domain> <type>" pairs runs one lookup per pair in a
		// single dig invocation (confirmed: a plain "<domain> A AAAA MX"
		// does NOT do this - dig just warns "extra type option" and keeps
		// only the last type given).
		for _, t := range allTypes {
			args = append(args, domain, t)
		}
	} else {
		args = append(args, domain, recordType)
	}

	start := time.Now()
	cmd := exec.CommandContext(ctx, "dig", args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	runErr := cmd.Run()
	elapsed := time.Since(start)

	output := out.String()
	if runErr != nil && strings.TrimSpace(output) == "" {
		return QueryResult{}, fmt.Errorf("dig failed: %w", runErr)
	}

	return QueryResult{
		Domain:     domain,
		Type:       recordType,
		DurationMs: elapsed.Milliseconds(),
		Output:     output,
	}, nil
}
