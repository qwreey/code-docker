package fonts

import "testing"

func TestCSSEscape(t *testing.T) {
	cases := map[string]string{
		`Plain`:      `Plain`,
		`It's`:       `It\'s`,
		`Trail\`:     `Trail\\`,
		`a\'b`:       `a\\\'b`,
		"line\nnext": `line\a next`,
	}
	for in, want := range cases {
		if got := cssEscape(in); got != want {
			t.Errorf("cssEscape(%q) = %q, want %q", in, got, want)
		}
	}
}
