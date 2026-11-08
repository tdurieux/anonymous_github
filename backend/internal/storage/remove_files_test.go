package storage

import (
	"context"
	"strings"
	"testing"
)

func TestRemoveFilesConfinedAndNonRecursive(t *testing.T) {
	s, err := New(Config{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	for _, p := range []string{"old", "new/file"} {
		if err := s.Put(ctx, "repo", p, strings.NewReader("data"), 4, 4); err != nil {
			t.Fatal(err)
		}
	}
	for _, invalid := range []string{"", "../escape", "/absolute"} {
		if err := s.RemoveFiles(ctx, "repo", []string{"old", invalid}); err == nil {
			t.Fatal("invalid path accepted", invalid)
		}
		if _, err := s.Size(ctx, "repo", "old"); err != nil {
			t.Fatal("partial deletion before validation", err)
		}
	}
	if err := s.RemoveFiles(ctx, "repo", []string{"new"}); err == nil {
		t.Fatal("nonempty directory removed")
	}
	if err := s.RemoveFiles(ctx, "repo", []string{"old", "missing"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Size(ctx, "repo", "new/file"); err != nil {
		t.Fatal("descendant deleted", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.RemoveFiles(cancelled, "repo", []string{"new/file"}); err != context.Canceled {
		t.Fatal(err)
	}
	if _, err := s.Size(ctx, "repo", "new/file"); err != nil {
		t.Fatal("cancelled deletion ran", err)
	}
}
