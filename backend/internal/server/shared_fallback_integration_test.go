package server

import (
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type fallbackTestBody struct {
	io.Reader
	closed atomic.Int32
}

func (r *fallbackTestBody) Close() error { r.closed.Add(1); return nil }

func runSharedFallbackIntegration(t *testing.T, s *Server, p *fixtureProvider) {
	t.Run("shared fallback completeness", func(t *testing.T) {
		ctx := t.Context()
		original, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		r := selectFields(original, "owner", "source", "providerAccess")
		r["_id"] = bson.NewObjectID()
		r["repoId"] = "fallback-" + r["_id"].(bson.ObjectID).Hex()
		r["status"] = "ready"
		r["treeGeneration"] = "fallback-generation"
		r["anonymizeDate"] = time.Now().Truncate(time.Millisecond)
		r["options"] = M{"terms": []string{"Alice"}, "image": true, "link": true, "expirationMode": "never"}
		if _, err = s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"data.txt", "data.bin"} {
			if _, err = s.Store.DB.Collection("files").InsertOne(ctx, M{"repoId": r["repoId"], "treeGeneration": r["treeGeneration"], "path": "", "name": name, "sha": "opaque:minimum", "size": 32}); err != nil {
				t.Fatal(err)
			}
		}
		access, err := s.providerAccess(r)
		if err != nil {
			t.Fatal(err)
		}
		oldSource, oldOpen := s.sourceCache, p.onOpen
		defer func() { s.sourceCache = oldSource; p.onOpen = oldOpen }()
		for _, mode := range []string{"budget", "object"} {
			t.Run(mode, func(t *testing.T) {
				budget, limit := int64(1), int64(4096)
				if mode == "object" {
					budget, limit = 65536, 8
				}
				cache, err := blobcache.New(ctx, blobcache.Options{Root: t.TempDir(), Budget: budget, MaxObject: limit})
				if err != nil {
					t.Fatal(err)
				}
				defer cache.Close()
				s.sourceCache = cache
				starts := s.pool.Stats()["workerStarts"].(uint64)
				for _, test := range []struct {
					name, content string
					failure       error
				}{
					{"data.txt", "Alice partial", nil}, {"data.txt", "", nil}, {"data.bin", strings.Repeat("\x00", 8), nil},
					{"data.txt", "Alice partial", errors.New("private upstream error")},
				} {
					var body *fallbackTestBody
					p.onOpen = func() (io.ReadCloser, error) {
						var input io.Reader = strings.NewReader(test.content)
						if test.failure != nil {
							input = io.MultiReader(input, failingFallbackReader{test.failure})
						}
						body = &fallbackTestBody{Reader: input}
						return body, nil
					}
					response := httptest.NewRecorder()
					s.ServeHTTP(response, httptest.NewRequest("GET", "/api/repo/"+str(r["repoId"])+"/file/"+test.name, nil))
					code := "storage_write_size_mismatch"
					if test.failure != nil {
						code = "file_not_available"
					}
					if response.Code != 502 || response.Body.String() != `{"error":"`+code+`"}` {
						t.Fatalf("%s: %d %s", test.name, response.Code, response.Body)
					}
					if body == nil || body.closed.Load() != 1 {
						t.Fatal("source not closed exactly once", body)
					}
				}
				if s.pool.Stats()["workerStarts"].(uint64) != starts {
					t.Fatal("short input launched a worker")
				}
				// Entry sizes are minimums: complete and expanded bodies remain valid.
				for _, size := range []int{32, 64} {
					p.onOpen = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(strings.Repeat("x", size))), nil }
					body, err := s.sharedSource(ctx, r, p, access, provider.Entry{Path: "data.txt", Revision: "opaque:minimum", Size: 32})
					if err != nil {
						t.Fatal(err)
					}
					data, err := io.ReadAll(body)
					body.Close()
					if err != nil || len(data) != size {
						t.Fatal(len(data), err)
					}
					for _, name := range []string{"data.txt", "data.bin"} {
						response := httptest.NewRecorder()
						s.ServeHTTP(response, httptest.NewRequest("GET", "/api/repo/"+str(r["repoId"])+"/file/"+name, nil))
						if response.Code != 200 || response.Body.String() != strings.Repeat("x", size) {
							t.Fatalf("complete %s: %d %s", name, response.Code, response.Body)
						}
					}
				}
				// A provider verifier owns its size semantics, such as Git LFS pointer
				// metadata. Admission fallback must not substitute the generic minimum.
				verified := &verifyingFixture{fixtureProvider: p}
				p.onOpen = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("small resolved payload")), nil }
				body, err := s.sharedSource(ctx, r, verified, access, provider.Entry{Path: "data.txt", Revision: "opaque:verified", Size: 32})
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(body)
				body.Close()
				if err != nil || string(data) != "small resolved payload" || verified.calls != 0 {
					t.Fatal(string(data), err, verified.calls)
				}
				stats, err := cache.Stats(ctx)
				if err != nil || stats.Blobs != 0 || stats.ReservedBytes != 0 || stats.ActiveReaders != 0 {
					t.Fatal(stats, err)
				}
			})
		}
		current, err := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if err != nil || number(current["pageView"]) != 8 {
			t.Fatal("view count includes failed sources or misses successful ones", current, err)
		}
	})
}

type failingFallbackReader struct{ err error }

func (r failingFallbackReader) Read([]byte) (int, error) { return 0, r.err }
