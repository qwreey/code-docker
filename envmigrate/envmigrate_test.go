package envmigrate

import (
	"strings"
	"testing"
)

var testOpts = Options{
	VersionKey:       "TEST_ENV_VERSION",
	EnvFileName:      ".env.test",
	TemplateFileName: "example-env.test",
}

func migrate(old, template string) Result {
	return Migrate(old, template, testOpts)
}

func findNote(notes []Note, level, substr string) bool {
	for _, n := range notes {
		if n.Level == level && strings.Contains(n.Message, substr) {
			return true
		}
	}
	return false
}

func TestMigrate_PreservesActiveValue(t *testing.T) {
	template := "#. desc\n#KEY_A=default\n"
	old := "KEY_A=custom\n"

	got := migrate(old, template).Output
	want := "#. desc\nKEY_A=custom\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestMigrate_PreservesUserComment_DropsAutoAndAdvisoryLeftovers(t *testing.T) {
	template := "#. desc\n#KEY_A=default\n"
	old := "# my note\n#. stale auto comment\n#!KEY_A=stale-echo\nKEY_A=custom\n"

	got := migrate(old, template).Output
	want := "# my note\n#. desc\nKEY_A=custom\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestMigrate_UnknownKeyGoesToDeadSection(t *testing.T) {
	template := "#. desc\n#KEY_A=default\n"
	old := "KEY_B=oldvalue\n"

	res := migrate(old, template)
	if !strings.Contains(res.Output, "#~KEY_B=oldvalue") {
		t.Errorf("expected dead-key archive line, got: %q", res.Output)
	}
	if !strings.Contains(res.Output, "더 이상 쓰이지 않음") {
		t.Errorf("expected dead-key section header, got: %q", res.Output)
	}
	if !findNote(res.Notes, "WARN", "KEY_B removed from template") {
		t.Errorf("expected WARN note about KEY_B removal, got: %+v", res.Notes)
	}
}

func TestMigrate_InactiveUnknownKeyNotArchived(t *testing.T) {
	template := "#. desc\n#KEY_A=default\n"
	old := "#KEY_B=neveractivated\n"

	res := migrate(old, template)
	if strings.Contains(res.Output, "KEY_B") {
		t.Errorf("inactive removed key should not be archived, got: %q", res.Output)
	}
}

func TestMigrate_AddedKeyUsesTemplateDefault(t *testing.T) {
	template := "#. desc\n#KEY_C=fresh-default\n"
	old := "" // fresh install, nothing set

	got := migrate(old, template).Output
	want := "#. desc\n#KEY_C=fresh-default\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestMigrate_ForcedKeyOverridesUserValue(t *testing.T) {
	template := "#!important\nKEY_D=mandated\n"
	old := "KEY_D=uservalue\n"

	res := migrate(old, template)
	want := "KEY_D=mandated\n"
	if res.Output != want {
		t.Errorf("got %q, want %q", res.Output, want)
	}
	if strings.Contains(res.Output, "!important") {
		t.Errorf("marker line must not leak into output, got: %q", res.Output)
	}
	if !findNote(res.Notes, "INFO", `KEY_D forced to "mandated" (was "uservalue")`) {
		t.Errorf("expected INFO note about forced override, got: %+v", res.Notes)
	}
}

func TestMigrate_ForcedKeyOnFreshInstallStillNotes(t *testing.T) {
	template := "#!important\nTEST_ENV_VERSION=2\n"
	old := ""

	res := migrate(old, template)
	if res.Output != "TEST_ENV_VERSION=2\n" {
		t.Errorf("got %q", res.Output)
	}
	if !findNote(res.Notes, "INFO", "was unset") {
		t.Errorf("expected INFO note noting the key was previously unset, got: %+v", res.Notes)
	}
}

func TestMigrate_FlaggedKeyKeepsUserValueAndShowsAdvisory(t *testing.T) {
	template := "#!important\nTEST_ENV_VERSION=3\n\n#. desc\n#!\n#KEY_E=newdefault\n"
	old := "TEST_ENV_VERSION=2\nKEY_E=oldvalue\n"

	res := migrate(old, template)
	if !strings.Contains(res.Output, "#!KEY_E=newdefault") {
		t.Errorf("expected advisory echo line, got: %q", res.Output)
	}
	if !strings.Contains(res.Output, "KEY_E=oldvalue") {
		t.Errorf("expected user's original value kept active, got: %q", res.Output)
	}
	for _, line := range strings.Split(res.Output, "\n") {
		if line == "KEY_E=newdefault" {
			t.Errorf("template's new value must stay inert (prefixed with #!), got a bare active line in: %q", res.Output)
		}
	}
	if !findNote(res.Notes, "WARN", "KEY_E recommended value changed") {
		t.Errorf("expected WARN note about the conflict, got: %+v", res.Notes)
	}
}

func TestMigrate_FlaggedKeyNoConflictWhenUserNeverSetIt(t *testing.T) {
	template := "#!\n#KEY_E=newdefault\n"
	old := "" // user never touched KEY_E

	got := migrate(old, template).Output
	want := "#KEY_E=newdefault\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestMigrate_CarriesForwardExistingDeadEntryWithoutReWarning(t *testing.T) {
	template := "#. desc\n#KEY_A=default\n"
	old := "#~ old note\n#~KEY_F=deadvalue\n"

	res := migrate(old, template)
	if !strings.Contains(res.Output, "#~ old note") {
		t.Errorf("expected carried-forward comment, got: %q", res.Output)
	}
	if !strings.Contains(res.Output, "#~KEY_F=deadvalue") {
		t.Errorf("expected carried-forward dead value, got: %q", res.Output)
	}
	if findNote(res.Notes, "WARN", "KEY_F removed from template") {
		t.Errorf("should not re-warn about an already-archived key, got: %+v", res.Notes)
	}
}

func TestMigrate_RevivedKeyUsesTemplateDefaultNotOldDeadValue(t *testing.T) {
	template := "#KEY_G=freshdefault\n"
	old := "#~KEY_G=deadvalue\n"

	got := migrate(old, template).Output
	want := "#KEY_G=freshdefault\n"
	if got != want {
		t.Errorf("got %q, want %q (revived key should not resurrect the old dead value)", got, want)
	}
}

func TestMigrate_EmptyOldFileYieldsTemplateAsIs(t *testing.T) {
	template := "#. desc\n#KEY_A=default\n#KEY_B=other\n"
	got := migrate("", template).Output
	if got != template {
		t.Errorf("got %q, want template unchanged %q", got, template)
	}
}

func TestParseVersion(t *testing.T) {
	if v := ParseVersion("#!important\nTEST_ENV_VERSION=5\n", "TEST_ENV_VERSION"); v != "5" {
		t.Errorf("got %q, want %q", v, "5")
	}
	if v := ParseVersion("#TEST_ENV_VERSION=5\n", "TEST_ENV_VERSION"); v != "" {
		t.Errorf("commented-out version should not count, got %q", v)
	}
	if v := ParseVersion("", "TEST_ENV_VERSION"); v != "" {
		t.Errorf("got %q, want empty", v)
	}
}
