package supervisor

import (
	"encoding/xml"
	"strings"
	"testing"
)

// TestSanitizeXMLAcceptsColoredLog pins the reason sanitizeXML exists:
// supervisord copies a program's log bytes into its response verbatim, so a
// program that colors its output produces a document Go's decoder refuses
// outright - the whole log read fails, not just that byte. Mirrors router's
// own copy of this package.
func TestSanitizeXMLAcceptsColoredLog(t *testing.T) {
	raw := []byte("<?xml version='1.0'?><methodResponse><params><param><value><string>" +
		"\x1b[32mINF\x1b[0m colored line\nplain line\n" +
		"</string></value></param></params></methodResponse>")

	var before methodResponse
	if err := xml.Unmarshal(raw, &before); err == nil {
		t.Fatal("xml.Unmarshal(raw) = nil error, want a failure - sanitizeXML would be unnecessary")
	}

	var after methodResponse
	if err := xml.Unmarshal(sanitizeXML(raw), &after); err != nil {
		t.Fatalf("xml.Unmarshal(sanitized) = %v, want success", err)
	}
	got := after.Params.Param[0].Value.asString()
	if strings.Contains(got, "\x1b") || strings.Contains(got, "[32m") {
		t.Fatalf("sanitized log still carries color: %q", got)
	}
	for _, want := range []string{"INF colored line", "plain line"} {
		if !strings.Contains(got, want) {
			t.Fatalf("sanitized log = %q, want it to contain %q", got, want)
		}
	}
}
