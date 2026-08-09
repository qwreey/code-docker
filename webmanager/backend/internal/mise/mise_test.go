package mise

import "testing"

// TestValidateToolIDRejectsAt guards against a real bug: callers build the
// exec argument as `id + "@" + version` (see handlers_mise.go), so an id
// containing its own "@" produces a mangled two-"@" spec instead of being
// rejected up front with a clear validation error.
func TestValidateToolIDRejectsAt(t *testing.T) {
	if err := ValidateToolID("python@1.0.0"); err == nil {
		t.Fatalf("ValidateToolID(id with @) = nil error, want ErrInvalidToolID")
	}
}

func TestValidateToolIDAcceptsBackendPrefixed(t *testing.T) {
	for _, id := range []string{"node", "npm:eslint", "cargo:ripgrep", "aqua:owner/repo"} {
		if err := ValidateToolID(id); err != nil {
			t.Errorf("ValidateToolID(%q) = %v, want success", id, err)
		}
	}
}

func TestValidateToolIDRejectsLeadingDash(t *testing.T) {
	if err := ValidateToolID("-rf"); err == nil {
		t.Fatalf("ValidateToolID(leading dash) = nil error, want ErrInvalidToolID")
	}
}
