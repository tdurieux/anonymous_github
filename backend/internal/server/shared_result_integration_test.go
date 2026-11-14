package server

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runSharedResultIntegration(t *testing.T, base *Server, p *fixtureProvider) {
	t.Run("shared transformed results", func(t *testing.T) {
		original, err := base.Store.one(t.Context(), collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		for _, mode := range []string{"changed", "unchanged", "binary", "admission"} {
			t.Run(mode, func(t *testing.T) {
				ctx := t.Context()
				expectedBody := fixtureContent
				if mode == "unchanged" {
					expectedBody = "nothing private here\n"
				}
				previousOpen := p.onOpen
				p.onOpen = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(expectedBody)), nil }
				defer func() { p.onOpen = previousOpen }()

				r := selectFields(original, "owner", "source", "providerAccess")
				r["_id"] = bson.NewObjectID()
				r["repoId"] = "result-" + r["_id"].(bson.ObjectID).Hex()
				r["status"] = "ready"
				r["treeGeneration"], r["anonymizeDate"] = "result-generation", time.Now().Truncate(time.Millisecond)
				r["options"] = M{"terms": []string{"Alice"}, "image": false, "link": false}
				if mode == "unchanged" {
					r["options"] = M{"terms": []string{}, "image": false, "link": false}
				}
				if _, err := base.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
					t.Fatal(err)
				}
				sourceRoot, resultRoot := t.TempDir(), t.TempDir()
				sources, err := blobcache.New(ctx, blobcache.Options{Root: sourceRoot, Budget: 65536, MaxObject: 4096})
				if err != nil {
					t.Fatal(err)
				}
				defer sources.Close()
				budget := int64(65536)
				if mode == "admission" {
					budget = 1
				}
				results, err := blobcache.New(ctx, blobcache.Options{Root: resultRoot, Budget: budget, MaxObject: 4096, Gzip: true})
				if err != nil {
					t.Fatal(err)
				}
				defer results.Close()
				s := &Server{Config: base.Config, Store: base.Store, providers: base.providers, content: base.content, pool: base.pool, sourceCache: sources, resultCache: results, cacheMetrics: testCacheMetrics()}
				row := M{"path": "", "name": "Alice.txt", "sha": "blob:shared-result", "size": len(expectedBody)}
				if mode == "binary" {
					row["name"] = "image.png"
				}
				read := func() (string, error) {
					reader, cleanup, _, err := s.transformed(ctx, r, row)
					if err != nil {
						return "", err
					}
					defer cleanup()
					data, err := io.ReadAll(reader)
					return string(data), err
				}
				start := s.pool.Stats()["workerStarts"].(uint64)
				first, err := read()
				if err != nil {
					t.Fatal(err)
				}
				if mode == "unchanged" || mode == "binary" {
					if first != expectedBody {
						t.Fatal("unchanged bytes rewritten", first)
					}
				} else if strings.Contains(first, "Alice") {
					t.Fatal("private term leaked", first)
				}
				cold := s.pool.Stats()["workerStarts"].(uint64)
				expected := uint64(1)
				if mode == "binary" {
					expected = 0
				}
				if cold-start != expected {
					t.Fatal("unexpected cold worker count", cold-start, expected)
				}
				// Reopen the SQLite cache through another connection to prove decisions and
				// results survive the first cache instance rather than a process-local map.
				reopened, err := blobcache.New(ctx, blobcache.Options{Root: resultRoot, Budget: budget, MaxObject: 4096, Gzip: true})
				if err != nil {
					t.Fatal(err)
				}
				defer reopened.Close()
				s.resultCache = reopened
				second, err := read()
				if err != nil || second != first {
					t.Fatal(second, first, err)
				}
				if got := s.pool.Stats()["workerStarts"].(uint64); got != cold {
					t.Fatal("warm request launched a worker", got, cold)
				}
				stats, err := reopened.Stats(ctx)
				if err != nil || stats.ReservedBytes != 0 || stats.ActiveReaders != 0 {
					t.Fatal(stats, err)
				}
				if mode == "changed" {
					if stats.Blobs != 1 || stats.Decisions != 1 {
						t.Fatal(stats)
					}
				} else if stats.Blobs != 0 {
					t.Fatal("stored redundant result", stats)
				}
				if mode != "admission" && stats.Decisions != 1 {
					t.Fatal("missing decision", stats)
				}
				// Warm internal transforms only authorize when output is released.
				authStart := p.authorizeCount.Load()
				if _, err := read(); err != nil {
					t.Fatal(err)
				}
				if got := p.authorizeCount.Load() - authStart; got != 1 {
					t.Fatalf("warm output authorization count %d", got)
				}
				// Revocation during a cold source fill must reject final output,
				// even though internal source release defers authorization.
				oldSHA, sourceOpen := row["sha"], p.onOpen
				row["sha"] = "blob:revoked-during-fill"
				p.onOpen = func() (io.ReadCloser, error) {
					p.revoked = true
					return io.NopCloser(strings.NewReader(expectedBody)), nil
				}
				_, revokedFillErr := read()
				row["sha"], p.onOpen, p.revoked = oldSHA, sourceOpen, false
				if revokedFillErr == nil || revokedFillErr.Error() != "fixture_access_revoked" {
					t.Fatal("revoked fill released transformed output", revokedFillErr)
				}
				p.revoked = true
				_, err = read()
				p.revoked = false
				if err == nil || err.Error() != "fixture_access_revoked" {
					t.Fatal("warm result bypassed access", err)
				}
				if mode == "changed" {
					// Missing result bytes invalidate that publication; its stale decision
					// must not suppress a fresh transformation.
					err = filepath.WalkDir(filepath.Join(resultRoot, "blobs"), func(name string, entry os.DirEntry, err error) error {
						if err != nil {
							return err
						}
						if !entry.IsDir() {
							return os.Remove(name)
						}
						return nil
					})
					if err != nil {
						t.Fatal(err)
					}
					recovered, err := read()
					if err != nil || recovered != first {
						t.Fatal("result eviction recovery", recovered, err)
					}
					if s.pool.Stats()["workerStarts"].(uint64) != cold+1 {
						t.Fatal("missing result did not rerun worker")
					}
					if err := s.resetContentCache(ctx, r); err != nil {
						t.Fatal(err)
					}
					if _, err := read(); err == nil || err.Error() != "repository_changed" {
						t.Fatal("old result scope survived reset", err)
					}
					r, err = s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
					if err != nil {
						t.Fatal(err)
					}
					resetOutput, err := read()
					if err != nil || resetOutput != first {
						t.Fatal("reset changed transformed bytes", resetOutput, err)
					}
					if s.pool.Stats()["workerStarts"].(uint64) != cold+2 {
						t.Fatal("reset reused stale decision")
					}

				}
			})
		}
	})
}
