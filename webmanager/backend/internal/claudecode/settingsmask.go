package claudecode

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// settings.json can carry credentials: its env block is where
// ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY or an MCP token usually go, and
// apiKeyHelper is a command that may embed one. GET /api/claude/settings is
// readable without the password gate (the rest of the file is harmless
// preferences), so behind a configured, locked gate those values are shown
// as placeholders instead.

const hiddenPrefix = "<hidden: "

func hiddenPlaceholder(name string) string { return hiddenPrefix + name + ">" }

// marshal is json.Marshal without HTML escaping, so a placeholder reads as
// <hidden: ...> rather than \u003chidden: ...\u003e - the same text the
// editor's own JSON.stringify writes back.
func marshal(v any, indent bool) ([]byte, error) {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if indent {
		enc.SetIndent("", "  ")
	}
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return []byte(strings.TrimSuffix(b.String(), "\n")), nil
}

// ErrHiddenValue is a save that still contains a placeholder with no value
// behind it in the current file (the key was renamed, or removed on disk).
var ErrHiddenValue = errors.New("settings contain a hidden value that no longer exists in the file; unlock and reload before editing it")

// SettingsVersion identifies the file's real content, so the editor can
// tell whether it changed on disk even while it shows a masked copy.
func SettingsVersion(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:16])
}

// MaskSettings returns raw with every env value and apiKeyHelper replaced
// by a placeholder. The result is re-indented JSON (key order sorted); it is
// a view, and RestoreHidden puts the real values back on save. A file that
// isn't a JSON object can't be masked and yields ok == false: show nothing.
func MaskSettings(raw string) (masked string, ok bool) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return "", false
	}
	if envRaw, found := obj["env"]; found {
		var env map[string]json.RawMessage
		if err := json.Unmarshal(envRaw, &env); err != nil {
			return "", false
		}
		for k := range env {
			env[k], _ = marshal(hiddenPlaceholder("env."+k), false)
		}
		obj["env"], _ = marshal(env, false)
	}
	if _, found := obj["apiKeyHelper"]; found {
		obj["apiKeyHelper"], _ = marshal(hiddenPlaceholder("apiKeyHelper"), false)
	}
	out, err := marshal(obj, true)
	if err != nil {
		return "", false
	}
	return string(out) + "\n", true
}

// RestoreHidden replaces each placeholder in submitted with the value it
// stands for in current (the file as it is on disk), so a save from the
// masked view - including one retried after unlocking - never writes a
// placeholder over a credential. Content without placeholders is returned
// unchanged.
func RestoreHidden(submitted, current string) (string, error) {
	if !strings.Contains(submitted, hiddenPrefix) && !strings.Contains(submitted, `\u003chidden: `) {
		return submitted, nil
	}
	var obj map[string]json.RawMessage
	_ = json.Unmarshal([]byte(current), &obj)
	replace := func(name string, value json.RawMessage) {
		// Either spelling: unescaped as MaskSettings writes it, or with <>
		// escaped as Go's default encoder would.
		plain, _ := marshal(hiddenPlaceholder(name), false)
		escaped, _ := json.Marshal(hiddenPlaceholder(name))
		submitted = strings.ReplaceAll(submitted, string(plain), string(value))
		submitted = strings.ReplaceAll(submitted, string(escaped), string(value))
	}
	var env map[string]json.RawMessage
	_ = json.Unmarshal(obj["env"], &env)
	for k, v := range env {
		replace("env."+k, v)
	}
	if v, found := obj["apiKeyHelper"]; found {
		replace("apiKeyHelper", v)
	}
	if i := strings.Index(strings.ReplaceAll(submitted, `\u003c`, "<"), hiddenPrefix); i >= 0 {
		submitted = strings.ReplaceAll(submitted, `\u003c`, "<")
		end := strings.IndexByte(submitted[i:], '>')
		if end < 0 {
			end = len(submitted) - i - 1
		}
		return "", fmt.Errorf("%w (%s)", ErrHiddenValue, submitted[i:i+end+1])
	}
	return submitted, nil
}
