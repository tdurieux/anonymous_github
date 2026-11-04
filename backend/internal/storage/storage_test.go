package storage

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFilesystemAtomicAndConfined(t *testing.T) {
	root := t.TempDir()
	s, e := New(Config{Root: root})
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	ctx := context.Background()
	if e = s.Put(ctx, "repo", "cache/file", strings.NewReader("complete"), 8, 10); e != nil {
		t.Fatal(e)
	}
	for _, input := range []string{"short", "longer-than-limit"} {
		if e = s.Put(ctx, "repo", "cache/file", strings.NewReader(input), 8, 10); e == nil {
			t.Fatal("invalid stream published")
		}
	}
	r, e := s.Read(ctx, "repo", "cache/file")
	if e != nil {
		t.Fatal(e)
	}
	b, e := io.ReadAll(r)
	r.Close()
	if e != nil || string(b) != "complete" {
		t.Fatalf("cache corrupted: %q %v", b, e)
	}
	for _, p := range []string{"../escape", "/absolute", "a/../../outside", "a\\b"} {
		if e = s.Put(ctx, "repo", p, strings.NewReader("x"), 1, 1); e == nil {
			t.Fatalf("unsafe path accepted %s", p)
		}
	}
	outside := t.TempDir()
	if e = os.Symlink(outside, filepath.Join(root, "repo", "original", "link")); e != nil {
		t.Fatal(e)
	}
	if e = s.Put(ctx, "repo", "link/escape", strings.NewReader("x"), 1, 1); e == nil {
		t.Fatal("symlink escaped root")
	}
	if e = s.Put(ctx, "repository", "keep", strings.NewReader("x"), 1, 1); e != nil {
		t.Fatal(e)
	}
	if e = s.Remove(ctx, "repo", ""); e != nil {
		t.Fatal(e)
	}
	if r, e = s.Read(ctx, "repository", "keep"); e != nil {
		t.Fatal("removed adjacent repository", e)
	}
	r.Close()
}
