package termsession

import "testing"

func TestClipboardFilter(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want string
	}{
		{"no escapes at all", []string{"hello world\r\n"}, "hello world\r\n"},
		{"osc 52 with BEL", []string{"a\x1b]52;c;aGVsbG8=\x07b"}, "ab"},
		{"osc 52 with ST", []string{"a\x1b]52;c;aGVsbG8=\x1b\\b"}, "ab"},
		{"osc 52 query", []string{"a\x1b]52;c;?\x07b"}, "ab"},
		{"osc 52 split across chunks", []string{"a\x1b]5", "2;c;aGVs", "bG8=\x07b"}, "ab"},
		{"osc 0 title kept", []string{"\x1b]0;title\x07x"}, "\x1b]0;title\x07x"},
		{"osc 7 cwd kept", []string{"\x1b]7;file:///code\x1b\\x"}, "\x1b]7;file:///code\x1b\\x"},
		{"osc 152 not matched", []string{"\x1b]152;x\x07"}, "\x1b]152;x\x07"},
		{"osc 8 hyperlink kept", []string{"\x1b]8;;https://a\x1b\\link\x1b]8;;\x1b\\"}, "\x1b]8;;https://a\x1b\\link\x1b]8;;\x1b\\"},
		{"csi untouched", []string{"\x1b[?1049h\x1b[2J\x1b[H"}, "\x1b[?1049h\x1b[2J\x1b[H"},
		{"esc esc then osc 52", []string{"\x1b\x1b]52;c;eA==\x07"}, "\x1b"},
		{"payload containing esc", []string{"\x1b]52;c;a\x1bb\x1b\\z"}, "z"},
		{"malformed osc identifier", []string{"\x1b]x52;c;a\x07"}, "\x1b]x52;c;a\x07"},
		{"empty osc 52", []string{"q\x1b]52\x07w"}, "qw"},
		{"two clipboard writes", []string{"\x1b]52;c;YQ==\x07mid\x1b]52;c;Yg==\x07end"}, "midend"},
		{"dcs payload passed through", []string{"\x1bP+q544\x1b\\x"}, "\x1bP+q544\x1b\\x"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newClipboardFilter()
			var got []byte
			for _, chunk := range tc.in {
				got = append(got, f.Filter([]byte(chunk))...)
			}
			if string(got) != tc.want {
				t.Fatalf("Filter() = %q, want %q", got, tc.want)
			}
		})
	}
}

// The chunk pump hands to Filter is the same one forwarded live to every
// attached sink, so filtering must never write into it.
func TestClipboardFilterDoesNotMutateInput(t *testing.T) {
	f := newClipboardFilter()
	in := []byte("a\x1b]52;c;aGVsbG8=\x07b")
	orig := string(in)
	f.Filter(in)
	if string(in) != orig {
		t.Fatalf("input mutated: %q, want %q", in, orig)
	}
}
