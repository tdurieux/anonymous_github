package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runFileMetadataIntegration(t *testing.T, s *Server, p *fixtureProvider) {
	t.Run("file metadata contracts", func(t *testing.T) {
		data, err := os.ReadFile("testdata/file-metadata.json")
		if err != nil {
			t.Fatal(err)
		}
		var cases []struct {
			Name        string
			Shared      bool
			Mode, Query string
			Expected    struct {
				Status                                                                   int
				Type, Encoding, Length, Ranges, Vary, Csp, Control, Nosniff, Disposition string
				Weak, Attachment                                                         bool
				Bytes                                                                    int
			}
		}
		if err = json.Unmarshal(data, &cases); err != nil {
			t.Fatal(err)
		}
		ctx := t.Context()
		original, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		r := selectFields(original, "owner", "source", "providerAccess")
		r["_id"] = bson.NewObjectID()
		r["repoId"] = "metadata-" + r["_id"].(bson.ObjectID).Hex()
		r["status"] = "ready"
		r["treeGeneration"] = "metadata-generation"
		r["anonymizeDate"] = time.Now().Truncate(time.Millisecond)
		r["options"] = M{"terms": []string{}, "image": true, "pdf": true, "expirationMode": "never"}
		if _, err = s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
			t.Fatal(err)
		}
		files := []any{}
		seen := map[string]bool{}
		for _, c := range cases {
			if !seen[c.Name] {
				seen[c.Name] = true
				files = append(files, M{"repoId": r["repoId"], "treeGeneration": r["treeGeneration"], "path": "", "name": c.Name, "sha": "metadata-blob", "size": 10})
			}
		}
		if _, err = s.Store.DB.Collection("files").InsertMany(ctx, files); err != nil {
			t.Fatal(err)
		}
		sources, err := blobcache.New(ctx, blobcache.Options{Root: t.TempDir(), Budget: 65536, MaxObject: 4096})
		if err != nil {
			t.Fatal(err)
		}
		defer sources.Close()
		results, err := blobcache.New(ctx, blobcache.Options{Root: t.TempDir(), Budget: 65536, MaxObject: 4096})
		if err != nil {
			t.Fatal(err)
		}
		defer results.Close()
		oldSource, oldResult, oldEnabled := s.sourceCache, s.resultCache, s.Config.SharedCacheEnabled
		defer func() { s.sourceCache, s.resultCache, s.Config.SharedCacheEnabled = oldSource, oldResult, oldEnabled }()
		opens, workers := p.openCount.Load(), s.pool.Stats()["workerStarts"].(uint64)
		for _, c := range cases {
			t.Run(c.Name+"/"+c.Mode+c.Query+map[bool]string{true: "/shared", false: "/legacy"}[c.Shared], func(t *testing.T) {
				s.Config.SharedCacheEnabled = c.Shared
				s.sourceCache, s.resultCache = nil, nil
				if c.Shared {
					s.sourceCache, s.resultCache = sources, results
				}
				server := httptest.NewServer(s)
				defer server.Close()
				transport := &http.Transport{DisableCompression: true}
				defer transport.CloseIdleConnections()
				client := &http.Client{Transport: transport}
				url := server.URL + "/api/repo/" + str(r["repoId"]) + "/file/" + neturl.PathEscape(c.Name) + c.Query
				do := func(method, tag string) (*http.Response, []byte) {
					req, _ := http.NewRequest(method, url, nil)
					accept := "gzip"
					if c.Mode == "reject-encoding" {
						accept = "*;q=0"
					}
					req.Header.Set("Accept-Encoding", accept)
					if tag != "" {
						req.Header.Set("If-None-Match", tag)
					}
					res, err := client.Do(req)
					if err != nil {
						t.Fatal(err)
					}
					body, err := io.ReadAll(res.Body)
					res.Body.Close()
					if err != nil {
						t.Fatal(err)
					}
					return res, body
				}
				response, body := do("HEAD", "")
				if c.Mode == "fresh" {
					response, body = do("GET", response.Header.Get("ETag"))
				}
				want := c.Expected
				if response.StatusCode != want.Status || len(body) != want.Bytes {
					t.Fatal(response.StatusCode, string(body), want)
				}
				for key, value := range map[string]string{"Content-Type": want.Type, "Content-Encoding": want.Encoding, "Content-Length": want.Length, "Accept-Ranges": want.Ranges, "Vary": want.Vary, "Content-Security-Policy": want.Csp, "Cache-Control": want.Control, "X-Content-Type-Options": want.Nosniff, "Content-Disposition": want.Disposition} {
					if got := response.Header.Get(key); got != value {
						t.Errorf("%s=%q, want %q", key, got, value)
					}
				}
				if strings.HasPrefix(response.Header.Get("ETag"), "W/") != want.Weak || (response.Header.Get("Content-Disposition") != "") != want.Attachment {
					t.Fatal(response.Header, want)
				}
			})
		}
		// Cached validators and unacceptable encodings must not bypass a revoked grant.
		p.revoked = true
		for _, method := range []string{"HEAD", "GET"} {
			req := httptest.NewRequest(method, "/api/repo/"+str(r["repoId"])+"/file/data.txt", nil)
			req.Header.Set("If-None-Match", "*")
			req.Header.Set("Accept-Encoding", "*;q=0")
			recorder := httptest.NewRecorder()
			s.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusForbidden {
				t.Errorf("revoked %s returned %d", method, recorder.Code)
			}
		}
		p.revoked = false
		if p.openCount.Load() != opens || s.pool.Stats()["workerStarts"].(uint64) != workers {
			t.Fatal("metadata requests read or transformed file content")
		}
		row, err := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if err != nil || number(row["pageView"]) != 0 {
			t.Fatal("metadata request counted a view", row, err)
		}
		for _, cache := range []*blobcache.Cache{sources, results} {
			stats, err := cache.Stats(ctx)
			if err != nil || stats.Blobs != 0 || stats.Decisions != 0 || stats.ActiveReaders != 0 {
				t.Fatal("metadata populated shared cache", stats, err)
			}
		}
	})
}
