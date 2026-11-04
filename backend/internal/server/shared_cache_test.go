package server

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

func TestSharedCacheConfiguration(t *testing.T) {
	t.Setenv("SESSION_SECRET", "synthetic-config")
	t.Setenv("CREDENTIAL_KEYS", `{"test":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`)
	t.Setenv("CREDENTIAL_ACTIVE_KEY_ID", "test")
	t.Setenv("SHARED_CACHE_ENABLED", "true")
	t.Setenv("SHARED_CACHE_DECISIONS", "true")
	t.Setenv("SHARED_CACHE_RESULT_BYTES", "32768")
	t.Setenv("SHARED_CACHE_PATH", t.TempDir())
	t.Setenv("SHARED_CACHE_BYTES", "65536")
	t.Setenv("SHARED_CACHE_MAX_FILE_BYTES", "4096")
	t.Setenv("SHARED_CACHE_FREE_BYTES", "0")
	t.Setenv("SHARED_CACHE_GZIP_MIN_SAVING", "0.2")
	t.Setenv("SHARED_CACHE_LOW_WATER", "0.8")
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !c.SharedCacheDecisions || c.SharedResultBytes != 32768 || !c.SharedCacheEnabled || c.SharedCache.Budget != 65536 || c.SharedCache.MaxObject != 4096 || c.SharedCache.FreeBytes != 0 || *c.SharedCache.Saving != 0.2 || *c.SharedCache.LowWater != 0.8 {
		t.Fatal(c.SharedCache)
	}
	for _, bad := range []struct{ key, value string }{{"SHARED_CACHE_RESULT_BYTES", "0"}, {"SHARED_CACHE_BYTES", "-1"}, {"SHARED_CACHE_MAX_FILE_BYTES", "bad"}, {"SHARED_CACHE_FREE_BYTES", "-1"}, {"SHARED_CACHE_LOW_WATER", "NaN"}, {"SHARED_CACHE_GZIP_MIN_SAVING", "1.1"}} {
		t.Run(bad.key, func(t *testing.T) {
			t.Setenv(bad.key, bad.value)
			if _, err := LoadConfig(); err == nil {
				t.Fatal("accepted invalid cache limit")
			}
		})
	}
}

func TestSharedCacheLifecycle(t *testing.T) {
	root := t.TempDir()
	s, err := New(Config{Storage: "filesystem", Root: t.TempDir(), PublicDir: t.TempDir(), Workers: 1, SharedCacheEnabled: true, SharedCacheDecisions: true, SharedResultBytes: 65536, SharedCache: blobcache.Options{Root: root, Budget: 65536, MaxObject: 4096}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if s.sourceCache == nil || s.resultCache == nil {
		t.Fatal("cache not initialized")
	}
	if _, err := os.Stat(filepath.Join(root, "source", "index.sqlite")); err != nil {
		s.Close()
		t.Fatal(err)
	}
	s.sharedCacheCancel()
	<-s.sharedCacheDone
	s.sharedCacheCancel = nil
	s.cacheMetrics = testCacheMetrics()
	// Use a request traffic value through the cache observer, without starting
	// the metrics flusher against a database in this unit test.
	ctx := context.WithValue(t.Context(), cacheTrafficKey{}, "website")
	reader, err := s.sourceCache.GetOrFill(ctx, "lifecycle", func(context.Context) (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("content")), nil }, nil, nil)
	if err != nil {
		s.cacheMetrics = nil
		s.Close()
		t.Fatal(err)
	}
	reader.Close()
	found := false
	for key := range s.cacheMetrics.pending {
		if key.name == "source_fill" && key.traffic == "website" {
			found = true
		}
	}
	s.cacheMetrics = nil
	s.Close()
	if _, err := s.resultCache.GetOrFill(t.Context(), "closed", nil, nil, nil); !errors.Is(err, os.ErrClosed) {
		t.Fatal("result cache survived shutdown", err)
	}
	if !found {
		t.Fatal("cache lost request traffic context")
	}
	if _, err := s.sourceCache.GetOrFill(t.Context(), "lifecycle", nil, nil, nil); !errors.Is(err, os.ErrClosed) {
		t.Fatal("cache survived server shutdown", err)
	}
	for _, storage := range []string{"s3", ""} {
		other := &Server{Config: Config{Storage: storage, SharedCacheEnabled: true}}
		if err := other.startSharedCache(); err != nil || other.sourceCache != nil {
			t.Fatal("unexpected shared filesystem cache", storage, err)
		}
	}
}

func TestSharedSourceProviderKeys(t *testing.T) {
	p := &fixtureProvider{}
	a := provider.Access{Ref: provider.Ref{Provider: "fixture", ID: "opaque:one", Commit: "revision:one"}}
	r := M{"treeGeneration": "generation"}
	entry := provider.Entry{Path: "a.txt", Revision: "blob:one"}
	key := sharedSourceKey(r, p, a, entry)
	for _, change := range []func(){func() { a.Ref.ID = "opaque:two" }, func() { a.Ref.Provider = "another" }, func() { entry.Path = "b.txt" }, func() { entry.Revision = "blob:two" }, func() { r["contentCacheRevision"] = "new" }} {
		change()
		if got := sharedSourceKey(r, p, a, entry); got == key {
			t.Fatal("cache identity collision")
		}
		key = sharedSourceKey(r, p, a, entry)
	}
	sha := strings.Repeat("a", 40)
	if got := sharedSourceKey(r, &githubProvider{}, a, provider.Entry{Revision: sha}); got != "git-"+sha {
		t.Fatal(got)
	}
}
