package claudecode

import (
	"errors"
	"strings"
	"testing"
)

const secretSettings = `{
  "model": "opus",
  "env": {"ANTHROPIC_AUTH_TOKEN": "sk-secret-1", "MCP_TOKEN": "tok\"2"},
  "apiKeyHelper": "echo sk-secret-3"
}`

func TestMaskSettingsHidesCredentials(t *testing.T) {
	masked, ok := MaskSettings(secretSettings)
	if !ok {
		t.Fatal("not masked")
	}
	for _, secret := range []string{"sk-secret-1", "tok", "sk-secret-3"} {
		if strings.Contains(masked, secret) {
			t.Fatalf("masked view still contains %q:\n%s", secret, masked)
		}
	}
	if !strings.Contains(masked, `"model": "opus"`) || !strings.Contains(masked, "<hidden: env.ANTHROPIC_AUTH_TOKEN>") {
		t.Fatalf("masked view lost the rest:\n%s", masked)
	}
	if _, ok := MaskSettings("{not json"); ok {
		t.Fatal("invalid JSON must not be shown")
	}
}

// Saving from the masked view (as the editor does when its save is retried
// after unlocking) must write the real values back, not the placeholders.
func TestRestoreHiddenPutsTheValuesBack(t *testing.T) {
	masked, _ := MaskSettings(secretSettings)
	edited := strings.Replace(masked, `"opus"`, `"sonnet"`, 1)
	restored, err := RestoreHidden(edited, secretSettings)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"sk-secret-1"`, `"tok\"2"`, `"echo sk-secret-3"`, `"sonnet"`} {
		if !strings.Contains(restored, want) {
			t.Fatalf("restored content lacks %s:\n%s", want, restored)
		}
	}
	if strings.Contains(restored, hiddenPrefix) {
		t.Fatalf("placeholder left in:\n%s", restored)
	}

	// The key was removed on disk meanwhile: nothing to restore from.
	if _, err := RestoreHidden(masked, `{"model": "opus"}`); !errors.Is(err, ErrHiddenValue) {
		t.Fatalf("restore without the original = %v, want ErrHiddenValue", err)
	}
	if got, err := RestoreHidden(`{"a": 1}`, secretSettings); err != nil || got != `{"a": 1}` {
		t.Fatalf("content without placeholders changed: %q %v", got, err)
	}
}
