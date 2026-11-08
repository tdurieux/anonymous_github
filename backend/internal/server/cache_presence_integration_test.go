package server

import (
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runCachePresenceIntegration(t *testing.T, s *Server, p *fixtureProvider) {
	t.Run("cache presence metadata", func(t *testing.T) {
		ctx := context.Background()
		source, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		r := selectFields(source, "owner", "source", "providerAccess", "options")
		r["_id"], r["repoId"], r["status"], r["treeGeneration"] = bson.NewObjectID(), "cache-presence", "ready", "presence-tree"
		before := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
		r["statusDate"], r["isReseted"], r["statusMessage"], r["size"] = before, true, "old-message", M{"storage": 0, "file": 0}
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
			t.Fatal(err)
		}
		defer func() { p.onOpen = nil; p.revoked = false }()
		load := func() M {
			t.Helper()
			v, e := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
			if e != nil {
				t.Fatal(e)
			}
			return v
		}
		row := M{"path": "", "name": "Alice.txt", "sha": "blob:one", "size": len(fixtureContent)}
		p.revoked = true
		if _, _, _, err := s.transformed(ctx, r, row); err == nil {
			t.Fatal("revoked read succeeded")
		}
		if current := load(); !boolean(current["isReseted"]) || !date(current["statusDate"]).Equal(before) {
			t.Fatal("failed read changed metadata", current)
		}
		p.revoked = false
		body, cleanup, _, err := s.transformed(ctx, r, row)
		if err != nil {
			t.Fatal(err)
		}
		_, err = io.ReadAll(body)
		cleanup()
		if err != nil {
			t.Fatal(err)
		}
		current := load()
		if boolean(current["isReseted"]) || !date(current["statusDate"]).After(before) || current["statusMessage"] != nil {
			t.Fatal(current)
		}
		if !date(r["statusDate"]).Equal(date(current["statusDate"])) || boolean(r["isReseted"]) {
			t.Fatal("caller snapshot not updated", r)
		}
		if number(obj(current["size"])["file"]) != 0 {
			t.Fatal("file read recomputed size", current)
		}
		if err := s.resetContentCache(ctx, current); err != nil {
			t.Fatal(err)
		}
		r = load()
		// Independent request snapshots downloading and transforming concurrently.
		snapshots := make([]M, 12)
		for i := range snapshots {
			snapshots[i] = load()
		}
		var group sync.WaitGroup
		results := make(chan error, len(snapshots))
		for _, snapshot := range snapshots {
			group.Add(1)
			go func(v M) {
				defer group.Done()
				body, cleanup, _, err := s.transformed(ctx, v, row)
				if err == nil {
					_, err = io.Copy(io.Discard, body)
					cleanup()
				}
				results <- err
			}(snapshot)
		}
		group.Wait()
		close(results)
		for err := range results {
			if err != nil {
				t.Fatal(err)
			}
		}
		current = load()
		for _, snapshot := range snapshots {
			if !date(snapshot["statusDate"]).Equal(date(current["statusDate"])) {
				t.Fatal("inconsistent concurrent snapshot")
			}
		}
		// A newer reset must not be marked present by an older reader.
		stale := load()
		stale["isReseted"] = true
		if err := s.resetContentCache(ctx, current); err != nil {
			t.Fatal(err)
		}
		if err := s.markCachePresent(ctx, stale); err == nil || err.Error() != "repository_changed" {
			t.Fatal("older reader cleared new reset", err)
		}
		r = load()
		p.onOpen = func() (io.ReadCloser, error) {
			_, err := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"status": "removing"}})
			if err != nil {
				return nil, err
			}
			return io.NopCloser(strings.NewReader(fixtureContent)), nil
		}
		if _, _, _, err := s.transformed(ctx, r, row); err == nil {
			t.Fatal("removal during read ignored")
		}
		current = load()
		if current["status"] != "removing" || !boolean(current["isReseted"]) {
			t.Fatal("late read changed removal", current)
		}
	})
}
