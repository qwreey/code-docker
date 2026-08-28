package manifestpatch

import "testing"

func TestParseEnv(t *testing.T) {
	got := parseEnv([]string{
		"PATH=/usr/bin",
		EnvPrefix + "TRILIUM=Trilium|https://note.example.com/|프로젝트 노트",
		EnvPrefix + "LOCAL_THING=Local|/manager/",
		EnvPrefix + "OFF=",
		EnvPrefix + "NOURL=JustAName",
		EnvPrefix + "BADSCHEME=Evil|javascript:alert(1)",
		EnvPrefix + "NOHOST=Broken|https://",
		EnvPrefix + "=Nameless|/x",
		EnvPrefix + "PROTOREL=Sneaky|//evil.example.com/",
	})

	if len(got) != 3 {
		t.Fatalf("expected 3 usable entries, got %d: %+v", len(got), got)
	}
	// Sorted by ID: local-thing, protorel, trilium.
	if got[0].ID != "local-thing" || got[1].ID != "protorel" || got[2].ID != "trilium" {
		t.Fatalf("unexpected order: %+v", got)
	}

	local := got[0]
	if local.OffOrigin {
		t.Errorf("a path target must stay in the manifest as-is, got OffOrigin")
	}
	if local.ManifestURL() != "/manager/" {
		t.Errorf("ManifestURL = %q, want /manager/", local.ManifestURL())
	}

	// A protocol-relative URL is another origin wearing a path's clothing —
	// it must not reach the manifest as if it were local.
	if !got[1].OffOrigin {
		t.Errorf("//host/... must be treated as off-origin")
	}

	tri := got[2]
	if !tri.OffOrigin {
		t.Errorf("an absolute URL must go through the goto stub")
	}
	if tri.ManifestURL() != GotoPrefix+"trilium" {
		t.Errorf("ManifestURL = %q, want %s", tri.ManifestURL(), GotoPrefix+"trilium")
	}
	if tri.Target != "https://note.example.com/" {
		t.Errorf("Target = %q", tri.Target)
	}
	if tri.Name != "Trilium" || tri.Description != "프로젝트 노트" {
		t.Errorf("name/description not parsed: %+v", tri)
	}
}

func TestParseEnvDescriptionKeepsPipes(t *testing.T) {
	got := parseEnv([]string{EnvPrefix + "X=Name|/p|a | b"})
	if len(got) != 1 || got[0].Description != "a | b" {
		t.Fatalf("description should keep later pipes, got %+v", got)
	}
}

func TestClassifyTargetRejects(t *testing.T) {
	for _, bad := range []string{"javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://h/x", "note.example.com"} {
		if _, err := classifyTarget(bad); err == nil {
			t.Errorf("classifyTarget(%q) should have failed", bad)
		}
	}
}
