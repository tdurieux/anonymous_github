package server

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runRawCacheIntegration(t *testing.T, s *Server, p *fixtureProvider) {
	t.Run("provider raw content cache", func(t *testing.T) {
		ctx := context.Background()
		original, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		r := selectFields(original, "owner", "source", "providerAccess", "options")
		r["_id"], r["repoId"], r["status"] = bson.NewObjectID(), "raw-cache-fixture", "ready"
		r["treeGeneration"], r["anonymizeDate"] = "cache-generation", time.Now().Truncate(time.Millisecond)
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
			t.Fatal(err)
		}
		defer func() { p.onOpen = nil; p.revoked = false }()
		row := M{"path": "", "name": "Alice.txt", "sha": "blob:one", "size": int64(len(fixtureContent))}
		a, err := s.providerAccess(r)
		if err != nil {
			t.Fatal(err)
		}
		key := rawCachePath(r, a, provider.Entry{Path: "Alice.txt", Revision: "blob:one"})
		cacheServer := &Server{Config: s.Config, Store: s.Store, content: s.content, providers: s.providers, cacheMetrics: testCacheMetrics()}
		read := func() error {
			body, err := cacheServer.blob(ctx, r, row)
			if err != nil {
				return err
			}
			defer body.Close()
			data, err := io.ReadAll(body)
			if err == nil && string(data) != fixtureContent {
				return errors.New("unexpected cached bytes")
			}
			return err
		}
		start := p.openCount.Load()
		for i := 0; i < 2; i++ {
			if err := read(); err != nil {
				t.Fatal(err)
			}
		}
		if got := p.openCount.Load() - start; got != 1 {
			t.Fatalf("two reads fetched upstream %d times", got)
		}
		counts := map[string]int64{}
		for key, v := range cacheServer.cacheMetrics.pending {
			counts[key.name] += v.count
		}
		for _, name := range []string{"legacy_source_hit", "legacy_source_miss", "source_fill", "source_stored"} {
			if counts[name] != 1 {
				t.Fatalf("cache instrumentation %s=%d", name, counts[name])
			}
		}
		if counts["source_hit"] != 0 || counts["source_miss"] != 0 {
			t.Fatal("per-repository reads polluted shared-cache hit/miss counters", counts)
		}
		for key, value := range cacheServer.cacheMetrics.pending {
			if key.name == "legacy_source_hit" || key.name == "legacy_source_miss" {
				if value.bytes != int64(len(fixtureContent)) || value.ms != 0 {
					t.Fatal("legacy source observation differs from TypeScript", key, value)
				}
			}
		}
		p.revoked = true
		if err := read(); err == nil || err.Error() != "fixture_access_revoked" {
			t.Fatal("cache bypassed revocation", err)
		}
		p.revoked = false
		// A truncated existing object must be replaced, never returned as a hit.
		if err := s.content.Put(ctx, str(r["repoId"]), key, strings.NewReader("short"), 5, 5); err != nil {
			t.Fatal(err)
		}
		if err := read(); err != nil {
			t.Fatal(err)
		}
		if p.openCount.Load()-start != 2 {
			t.Fatal("short entry was not refilled")
		}
		if err := s.runJob(ctx, M{"kind": "repo", "resourceId": r["repoId"], "action": "cache"}); err != nil {
			t.Fatal(err)
		}
		if err := read(); err == nil || err.Error() != "repository_changed" {
			t.Fatal("old revision remained readable", err)
		}
		current, err := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if err != nil || !boolean(current["isReseted"]) || str(current["contentCacheRevision"]) == "" {
			t.Fatal("cache reset state", current, err)
		}
		r["contentCacheRevision"] = current["contentCacheRevision"]
		key = rawCachePath(r, a, provider.Entry{Path: "Alice.txt", Revision: "blob:one"})
		if err := read(); err != nil {
			t.Fatal(err)
		}
		if p.openCount.Load()-start != 3 {
			t.Fatal("new revision reused old cache")
		}
		if err := s.content.Remove(ctx, str(r["repoId"]), key); err != nil {
			t.Fatal(err)
		}
		p.onOpen = func() (io.ReadCloser, error) {
			time.Sleep(50 * time.Millisecond)
			return io.NopCloser(strings.NewReader(fixtureContent)), nil
		}
		start = p.openCount.Load()
		var group sync.WaitGroup
		results := make(chan error, 12)
		for i := 0; i < 12; i++ {
			group.Add(1)
			go func() { defer group.Done(); results <- read() }()
		}
		group.Wait()
		close(results)
		for err := range results {
			if err != nil {
				t.Fatal(err)
			}
		}
		if got := p.openCount.Load() - start; got != 1 {
			t.Fatalf("concurrent cache miss fetched %d times", got)
		}
		p.onOpen = nil
		if err := s.content.Remove(ctx, str(r["repoId"]), key); err != nil {
			t.Fatal(err)
		}
		p.onOpen = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("short")), nil }
		if err := read(); err == nil {
			t.Fatal("short download accepted")
		}
		if _, err := s.content.Size(ctx, str(r["repoId"]), key); !errors.Is(err, fs.ErrNotExist) {
			t.Fatal("failed fill published", err)
		}
		p.onOpen = nil
		if err := read(); err != nil {
			t.Fatal("failed fill prevented retry", err)
		}
		if err := s.content.Remove(ctx, str(r["repoId"]), key); err != nil {
			t.Fatal(err)
		}
		// Simulate expiration after downloading starts. The late publication is
		// removed even if lifecycle cleanup has already deleted the storage root.
		p.onOpen = func() (io.ReadCloser, error) {
			_, err := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"status": "removed"}})
			if err != nil {
				return nil, err
			}
			if err := s.content.Remove(ctx, str(r["repoId"]), ""); err != nil {
				return nil, err
			}
			return io.NopCloser(strings.NewReader(fixtureContent)), nil
		}
		if err := read(); err == nil || err.Error() != "repository_changed" {
			t.Fatal("stale fill accepted", err)
		}
		if _, err := s.content.Size(ctx, str(r["repoId"]), key); !errors.Is(err, fs.ErrNotExist) {
			t.Fatal("stale fill retained", err)
		}
		p.onOpen = nil
		if _, err := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"status": "ready"}}); err != nil {
			t.Fatal(err)
		}
		marker := "__content/__retired/" + strings.TrimPrefix(contentPrefix(r), "__content/") + ".txt"
		if err := s.content.Put(ctx, str(r["repoId"]), marker, strings.NewReader("retired"), 7, 7); err != nil {
			t.Fatal(err)
		}
		start = p.openCount.Load()
		if err := read(); err == nil || err.Error() != "repository_changed" {
			t.Fatal("retirement marker ignored", err)
		}
		if p.openCount.Load() != start {
			t.Fatal("retired generation fetched content")
		}

	})
}
