package server

import (
	"io"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runLegacySourceIntegration(t *testing.T, s *Server) {
	t.Run("legacy source promotion", func(t *testing.T) {
		ctx := t.Context()
		original, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil || original == nil {
			t.Fatal(original, err)
		}
		for _, layout := range []int{0, 1, 2} {
			for _, mode := range []string{"valid", "corrupt", "short", "unverified", "admission", "revoked", "revoke-during-verification", "remove-during-verification"} {
				t.Run(string(rune('0'+layout))+"/"+mode, func(t *testing.T) {
					r := selectFields(original, "owner", "source", "providerAccess", "options")
					r["_id"] = bson.NewObjectID()
					r["repoId"] = "legacy-source-" + r["_id"].(bson.ObjectID).Hex()
					r["status"] = "ready"
					r["treeGeneration"], r["anonymizeDate"] = "legacy-test", time.Now().Truncate(time.Millisecond)
					if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
						t.Fatal(err)
					}
					access, err := s.providerAccess(r)
					if err != nil {
						t.Fatal(err)
					}
					entry := provider.Entry{Path: "Alice.txt", Revision: "opaque:legacy", Size: int64(len(fixtureContent))}
					name := legacySourcePaths(r, access, entry)[layout]
					data := fixtureContent
					if mode == "corrupt" || mode == "admission" || mode == "unverified" {
						data = strings.Repeat("x", len(fixtureContent))
					}
					if mode == "short" {
						data = "short"
					}
					if err := s.content.Put(ctx, str(r["repoId"]), name, strings.NewReader(data), int64(len(data)), 4096); err != nil {
						t.Fatal(err)
					}
					budget := int64(65536)
					if mode == "admission" {
						budget = 1
					}
					cache, err := blobcache.New(ctx, blobcache.Options{Root: t.TempDir(), Budget: budget, MaxObject: 4096})
					if err != nil {
						t.Fatal(err)
					}
					defer cache.Close()
					base := &fixtureProvider{}
					verified := &verifyingFixture{fixtureProvider: base}
					var adapter provider.Repositories = verified
					if mode == "unverified" {
						adapter = base
					}
					if mode == "revoked" {
						base.revoked = true
					}
					if mode == "revoke-during-verification" {
						verified.afterVerify = func() { base.revoked = true }
					}
					if mode == "remove-during-verification" {
						verified.afterVerify = func() {
							if _, err := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"status": "removed"}}); err != nil {
								t.Error(err)
							}
						}
					}
					serving := &Server{Store: s.Store, content: s.content, sourceCache: cache, cacheMetrics: testCacheMetrics()}
					read := func() (string, error) {
						body, err := serving.cachedBlob(ctx, r, adapter, access, entry)
						if err != nil {
							return "", err
						}
						defer body.Close()
						out, err := io.ReadAll(body)
						return string(out), err
					}
					out, err := read()
					if mode == "revoked" || mode == "revoke-during-verification" || mode == "remove-during-verification" {
						expected := "fixture_access_revoked"
						if mode == "remove-during-verification" {
							expected = "repository_changed"
						}
						if err == nil || err.Error() != expected || out != "" || base.openCount.Load() != 0 {
							t.Fatal(out, err, base.openCount.Load())
						}
					} else {
						if err != nil || out != fixtureContent {
							t.Fatal(out, err)
						}
						downloads := int64(1)
						if mode == "valid" {
							downloads = 0
						}
						if base.openCount.Load() != downloads {
							t.Fatal("wrong upstream count", base.openCount.Load(), downloads)
						}
						if mode == "valid" && verified.calls != 1 || mode == "corrupt" && verified.calls != 2 || mode == "admission" && verified.calls != 0 {
							t.Fatal("wrong verification count", verified.calls)
						}
						if mode != "admission" {
							if _, err = read(); err != nil || base.openCount.Load() != downloads {
								t.Fatal("warm promotion downloaded", err, base.openCount.Load())
							}
						}
					}
					stats, err := cache.Stats(ctx)
					if err != nil || stats.ReservedBytes != 0 || stats.ActiveReaders != 0 {
						t.Fatal(stats, err)
					}
					// Promotion leaves legacy bytes in place for rollback; corrupt bytes are
					// never trusted merely because a prior attempt encountered the same path.
					stored, err := s.content.Read(ctx, str(r["repoId"]), name)
					if err != nil {
						t.Fatal(err)
					}
					preserved, err := io.ReadAll(stored)
					stored.Close()
					if err != nil || string(preserved) != data {
						t.Fatal("legacy content changed", err)
					}
				})
			}
		}
	})
}
