package files

import (
	"mime"
	"testing"
)

// Whatever the filename holds, the header must parse back to an attachment
// carrying that name minus control characters - a quote or backslash must
// not end the parameter early.
func TestAttachmentDisposition(t *testing.T) {
	for name, want := range map[string]string{
		"report.pdf":           "report.pdf",
		`a"b\c.html`:           `a"b\c.html`,
		"한글 파일.txt":            "한글 파일.txt",
		"line\r\nbreak\x00.sh": "linebreak.sh",
		"":                     "download",
	} {
		v := AttachmentDisposition(name)
		disp, params, err := mime.ParseMediaType(v)
		if err != nil || disp != "attachment" || params["filename"] != want {
			t.Errorf("AttachmentDisposition(%q) = %q -> (%q, %q, %v), want attachment with filename %q", name, v, disp, params["filename"], err, want)
		}
	}
}
