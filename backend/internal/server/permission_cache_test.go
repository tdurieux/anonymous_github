package server

import (
	"errors"
	"testing"
	"time"
)

func TestPermissionCache(t *testing.T) {
	s := &Server{Config: Config{GitHubPermissionTTL: time.Hour}}
	calls := 0
	check := func() error { calls++; return nil }
	key := []string{"owner", "token", "repo", "revision"}
	for range 3 {
		if err := s.cachedPermission(key, check); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatal("successful check not reused", calls)
	}
	for _, changed := range [][]string{{"other", "token", "repo", "revision"}, {"owner", "new-token", "repo", "revision"}, {"owner", "token", "other-repo", "revision"}, {"owner", "token", "repo", "new-revision"}} {
		s.cachedPermission(changed, check)
	}
	if calls != 5 {
		t.Fatal("cache crossed security identities", calls)
	}
	for k := range s.permissions.entries {
		s.permissions.entries[k] = time.Now().Add(-time.Second)
	}
	s.cachedPermission(key, check)
	if calls != 6 {
		t.Fatal("expired grant reused")
	}
	failures := 0
	for range 2 {
		if err := s.cachedPermission([]string{"denied"}, func() error { failures++; return errors.New("denied") }); err == nil {
			t.Fatal("denial lost")
		}
	}
	if failures != 2 {
		t.Fatal("failure cached")
	}
	s.Config.GitHubPermissionTTL = 0
	s.cachedPermission(key, check)
	s.cachedPermission(key, check)
	if calls != 8 {
		t.Fatal("disabled cache used")
	}
}
