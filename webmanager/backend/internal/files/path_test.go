package files

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// testRoot builds a root with the layout every case below shares:
//
//	<root>/sub/               plain directory
//	<root>/sub/file.txt       plain file
//	<root>/inside -> sub      symlink pointing inside the root
//	<root>/evil   -> <out>    symlink pointing outside the root
//	<root>/dangling -> nope   symlink whose target doesn't exist
//	<out>/secret.txt          the file an escape would reach
//
// It returns the (already symlink-free) root and the outside directory.
func testRoot(t *testing.T) (root, outside string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root = filepath.Join(base, "root")
	outside = filepath.Join(base, "outside")
	for _, d := range []string{filepath.Join(root, "sub"), outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "file.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("sub", filepath.Join(root, "inside")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "evil")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "nope"), filepath.Join(root, "dangling")); err != nil {
		t.Fatal(err)
	}
	return root, outside
}

func TestResolveForAccess(t *testing.T) {
	root, outside := testRoot(t)

	cases := []struct {
		name    string
		path    string
		want    string // expected resolved path ("" when wantErr is set)
		wantErr error
	}{
		// The core C3 case: an escaping ancestor symlink plus a leaf that
		// doesn't exist yet (mkdir / content PUT / upload destination).
		// EvalSymlinks fails on the missing leaf, which the old code
		// treated as "safe" and let through unresolved.
		{name: "escaping ancestor, new leaf", path: filepath.Join(root, "evil", "newfile"), wantErr: ErrInvalidPath},
		{name: "escaping ancestor, deep new leaf", path: filepath.Join(root, "evil", "etc", "cron.d", "x"), wantErr: ErrInvalidPath},
		{name: "escaping ancestor, existing leaf", path: filepath.Join(root, "evil", "secret.txt"), wantErr: ErrInvalidPath},
		{name: "leaf is escaping symlink", path: filepath.Join(root, "evil"), wantErr: ErrInvalidPath},
		{name: "dangling leaf symlink", path: filepath.Join(root, "dangling"), wantErr: ErrInvalidPath},

		// Links that stay inside the root keep working, resolved.
		{name: "symlink inside root", path: filepath.Join(root, "inside"), want: filepath.Join(root, "sub")},
		{name: "through symlink inside root", path: filepath.Join(root, "inside", "file.txt"), want: filepath.Join(root, "sub", "file.txt")},
		{name: "new leaf under symlink inside root", path: filepath.Join(root, "inside", "new.txt"), want: filepath.Join(root, "sub", "new.txt")},

		// Plain paths, symlink-free.
		{name: "root itself", path: root, want: root},
		{name: "existing file", path: filepath.Join(root, "sub", "file.txt"), want: filepath.Join(root, "sub", "file.txt")},
		{name: "nonexistent deep path", path: filepath.Join(root, "a", "b", "c"), want: filepath.Join(root, "a", "b", "c")},
		{name: "empty means root", path: "", want: root},

		// Lexical escapes stay rejected.
		{name: "outside root", path: filepath.Join(outside, "secret.txt"), wantErr: ErrInvalidPath},
		{name: "root-prefix confusion", path: root + "-evil/x", wantErr: ErrInvalidPath},
		{name: "dotdot escape", path: filepath.Join(root, "sub", "..", "..", "outside"), wantErr: ErrInvalidPath},
		{name: "relative path", path: "sub/file.txt", wantErr: ErrInvalidPath},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveForAccess(root, tc.path)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("ResolveForAccess(%q) = (%q, %v), want error %v", tc.path, got, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveForAccess(%q) unexpected error: %v", tc.path, err)
			}
			if got != tc.want {
				t.Fatalf("ResolveForAccess(%q) = %q, want %q", tc.path, got, tc.want)
			}
		})
	}
}

func TestResolveNonRoot(t *testing.T) {
	root, outside := testRoot(t)

	cases := []struct {
		name    string
		path    string
		want    string
		wantErr error
	}{
		// Deleting/renaming *through* an escaping ancestor is rejected...
		{name: "delete through escaping ancestor", path: filepath.Join(root, "evil", "secret.txt"), wantErr: ErrInvalidPath},
		{name: "delete deep through escaping ancestor", path: filepath.Join(root, "evil", "etc", "passwd"), wantErr: ErrInvalidPath},
		// ...but the escaping link entry itself is still removable: the
		// last component is never followed.
		{name: "delete the escaping link itself", path: filepath.Join(root, "evil"), want: filepath.Join(root, "evil")},
		{name: "delete a dangling link", path: filepath.Join(root, "dangling"), want: filepath.Join(root, "dangling")},
		{name: "delete an inside link itself", path: filepath.Join(root, "inside"), want: filepath.Join(root, "inside")},

		{name: "through inside link", path: filepath.Join(root, "inside", "file.txt"), want: filepath.Join(root, "sub", "file.txt")},
		{name: "plain file", path: filepath.Join(root, "sub", "file.txt"), want: filepath.Join(root, "sub", "file.txt")},
		{name: "nonexistent leaf", path: filepath.Join(root, "sub", "gone.txt"), want: filepath.Join(root, "sub", "gone.txt")},

		{name: "root itself", path: root, wantErr: ErrRootPath},
		{name: "empty means root", path: "", wantErr: ErrRootPath},
		{name: "outside root", path: filepath.Join(outside, "secret.txt"), wantErr: ErrInvalidPath},
		{name: "root-prefix confusion", path: root + "-evil/x", wantErr: ErrInvalidPath},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveNonRoot(root, tc.path)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("ResolveNonRoot(%q) = (%q, %v), want error %v", tc.path, got, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveNonRoot(%q) unexpected error: %v", tc.path, err)
			}
			if got != tc.want {
				t.Fatalf("ResolveNonRoot(%q) = %q, want %q", tc.path, got, tc.want)
			}
		})
	}
}

// TestMutationsThroughEscapingAncestor exercises the real entry points the
// security review listed, not just the resolver, so a future refactor that
// bypasses these helpers fails here too.
func TestMutationsThroughEscapingAncestor(t *testing.T) {
	root, outside := testRoot(t)

	if err := Mkdir(root, filepath.Join(root, "evil", "made-it")); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("Mkdir through escaping ancestor = %v, want ErrInvalidPath", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "made-it")); !os.IsNotExist(err) {
		t.Fatalf("Mkdir escaped the root: %v", err)
	}

	if err := WriteTextContent(root, filepath.Join(root, "evil", "written.txt"), "x"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("WriteTextContent through escaping ancestor = %v, want ErrInvalidPath", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "written.txt")); !os.IsNotExist(err) {
		t.Fatalf("WriteTextContent escaped the root: %v", err)
	}

	results := Delete(root, []string{filepath.Join(root, "evil", "secret.txt")})
	if len(results) != 1 || results[0].Ok {
		t.Fatalf("Delete through escaping ancestor = %+v, want failure", results)
	}
	if _, err := os.Stat(filepath.Join(outside, "secret.txt")); err != nil {
		t.Fatalf("Delete escaped the root: secret.txt is gone (%v)", err)
	}

	if _, _, err := OpenUploadDest(root, filepath.Join(root, "evil"), "up.txt"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("OpenUploadDest into escaping dir = %v, want ErrInvalidPath", err)
	}

	// Removing the escaping link entry itself must still work.
	results = Delete(root, []string{filepath.Join(root, "evil")})
	if len(results) != 1 || !results[0].Ok {
		t.Fatalf("Delete of the link entry = %+v, want success", results)
	}
	if _, err := os.Lstat(filepath.Join(root, "evil")); !os.IsNotExist(err) {
		t.Fatalf("link entry still present: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "secret.txt")); err != nil {
		t.Fatalf("deleting the link removed its target: %v", err)
	}
}

// TestSymlinkedRoot covers a root that is itself a symlink — paths arrive
// spelled either way and both must resolve to the same real tree.
func TestSymlinkedRoot(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(base, "real")
	link := filepath.Join(base, "link")
	if err := os.MkdirAll(filepath.Join(real, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}

	for _, p := range []string{filepath.Join(link, "sub"), filepath.Join(real, "sub")} {
		got, err := ResolveForAccess(link, p)
		if err != nil {
			t.Fatalf("ResolveForAccess(%q, %q): %v", link, p, err)
		}
		if got != filepath.Join(real, "sub") {
			t.Fatalf("ResolveForAccess(%q, %q) = %q, want %q", link, p, got, filepath.Join(real, "sub"))
		}
	}
	if _, err := ResolveForAccess(link, filepath.Join(base, "elsewhere")); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("escape from symlinked root = %v, want ErrInvalidPath", err)
	}
}

func TestMissingRootIsRejected(t *testing.T) {
	root := filepath.Join(t.TempDir(), "does-not-exist")
	if _, err := ResolveForAccess(root, filepath.Join(root, "x")); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("ResolveForAccess with missing root = %v, want ErrInvalidPath", err)
	}
}

// TestWriteOntoEscapingLeafSymlink covers the other half of the leaf case:
// the destination itself already exists *as* a link out of the root, and
// os.OpenFile/copy would follow it. Deleting such a link is still allowed
// (TestResolveNonRoot); writing through it is not.
func TestWriteOntoEscapingLeafSymlink(t *testing.T) {
	root, outside := testRoot(t)
	target := filepath.Join(outside, "target.txt")
	if err := os.WriteFile(target, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "sub", "pwn")); err != nil {
		t.Fatal(err)
	}

	if _, _, err := OpenUploadDest(root, filepath.Join(root, "sub"), "pwn"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("OpenUploadDest onto an escaping link = %v, want ErrInvalidPath", err)
	}
	if err := WriteTextContent(root, filepath.Join(root, "sub", "pwn"), "pwned"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("WriteTextContent onto an escaping link = %v, want ErrInvalidPath", err)
	}

	// Copy a same-named file over it.
	src := filepath.Join(root, "src")
	if err := os.Mkdir(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "pwn"), []byte("pwned"), 0o644); err != nil {
		t.Fatal(err)
	}
	results := Copy(root, []string{filepath.Join(src, "pwn")}, filepath.Join(root, "sub"))
	if len(results) != 1 || results[0].Ok {
		t.Fatalf("Copy onto an escaping link = %+v, want failure", results)
	}

	if b, err := os.ReadFile(target); err != nil || string(b) != "original" {
		t.Fatalf("escaping link target was written through: %q %v", b, err)
	}
}
