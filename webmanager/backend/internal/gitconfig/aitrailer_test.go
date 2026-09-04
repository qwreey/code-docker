package gitconfig

import "testing"

// An unset config file must not read as "everything off": enabled defaults
// false but keepModel/stripSession default true, matching the hook, which
// treats only an explicit "false" as off.
func TestGetAITrailerDefaults(t *testing.T) {
	path := t.TempDir() + "/.gitconfig"

	got, err := GetAITrailer(path)
	if err != nil {
		t.Fatalf("GetAITrailer() = %v", err)
	}
	if got.Enabled {
		t.Errorf("Enabled = true, want false on an unconfigured file")
	}
	if !got.KeepModel {
		t.Errorf("KeepModel = false, want true by default")
	}
	if !got.StripSession {
		t.Errorf("StripSession = false, want true by default")
	}
	if got.HookActive {
		t.Errorf("HookActive = true, want false with no core.hooksPath set")
	}
}

func TestSetAITrailerRoundTrip(t *testing.T) {
	path := t.TempDir() + "/.gitconfig"

	want := AITrailer{
		Enabled:      true,
		Name:         "qwreey-bot",
		Email:        "bot@qwreey.moe",
		KeepModel:    false,
		StripSession: false,
	}
	if err := SetAITrailer(path, want); err != nil {
		t.Fatalf("SetAITrailer() = %v", err)
	}

	got, err := GetAITrailer(path)
	if err != nil {
		t.Fatalf("GetAITrailer() = %v", err)
	}
	if got.Enabled != want.Enabled || got.Name != want.Name || got.Email != want.Email {
		t.Errorf("round trip = %+v, want %+v", got, want)
	}
	// The interesting half: false must survive, since unset means true.
	if got.KeepModel || got.StripSession {
		t.Errorf("KeepModel/StripSession = %v/%v, want false/false", got.KeepModel, got.StripSession)
	}
}

// Clearing the name in the UI has to restore the user.name fallback rather
// than persist an empty string the hook would then use verbatim.
func TestSetAITrailerClearsNameToUnset(t *testing.T) {
	path := t.TempDir() + "/.gitconfig"

	if err := SetAITrailer(path, AITrailer{Enabled: true, Name: "bot", Email: "b@e.xyz"}); err != nil {
		t.Fatalf("SetAITrailer() = %v", err)
	}
	if err := SetAITrailer(path, AITrailer{Enabled: true}); err != nil {
		t.Fatalf("SetAITrailer(cleared) = %v", err)
	}

	got, err := GetAITrailer(path)
	if err != nil {
		t.Fatalf("GetAITrailer() = %v", err)
	}
	if got.Name != "" || got.Email != "" {
		t.Errorf("Name/Email = %q/%q, want both empty", got.Name, got.Email)
	}
}

// Both fields land inside "Name <email>", so anything that could close or
// open an address, or start a second line, must be refused.
func TestSetAITrailerRejectsMalformedIdentity(t *testing.T) {
	cases := []struct {
		name string
		in   AITrailer
	}{
		{"angle bracket in name", AITrailer{Name: "bot <evil@x.com>", Email: "b@e.xyz"}},
		{"angle bracket in email", AITrailer{Name: "bot", Email: "b@e.xyz> <other@x.com"}},
		{"newline in name", AITrailer{Name: "bot\nCo-Authored-By: x <y@z>", Email: "b@e.xyz"}},
		{"newline in email", AITrailer{Name: "bot", Email: "b@e.xyz\nSigned-off-by: x"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := t.TempDir() + "/.gitconfig"
			if err := SetAITrailer(path, tc.in); err == nil {
				t.Fatalf("SetAITrailer(%+v) = nil error, want rejection", tc.in)
			}
		})
	}
}
