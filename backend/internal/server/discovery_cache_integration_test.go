package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runDiscoveryCacheIntegration(t *testing.T, base *Server) {
	t.Run("OAuth discovery cache and refresh", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		user := M{"_id": owner, "username": "discovery-cache-" + owner.Hex(), "status": "active"}
		if _, err := base.Store.DB.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		s := &Server{Config: base.Config, Store: base.Store}
		s.Config.AppEnabled = false
		adapter := &githubProvider{server: s}
		var err error
		s.providers, err = provider.New(adapter)
		if err != nil {
			t.Fatal(err)
		}
		grantRequest := &request{Server: s, R: httptest.NewRequest("GET", "/", nil)}
		grant := func() {
			t.Helper()
			if err := s.saveGrant(grantRequest, owner, "github", M{"access_token": "synthetic-cache-token"}); err != nil {
				t.Fatal(err)
			}
		}
		grant()
		repoID := "88190001"
		body := []M{{"id": 88190001, "full_name": "cache/original", "html_url": "https://github.com/cache/original", "size": 42, "default_branch": "trunk"}}
		calls := 0
		status := 200
		var duringFetch func()
		s.HTTP = &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
			calls++
			if req.URL.Path != "/user/repos" || req.URL.Query().Get("sort") != "pushed" {
				t.Fatalf("unexpected request %s", req.URL)
			}
			if duringFetch != nil {
				duringFetch()
			}
			raw, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
		})}
		list := func(query string) ([]M, error) {
			q := &request{Server: s, User: user, Params: map[string]string{}, R: httptest.NewRequest("GET", "/api/user/all_repositories"+query, nil)}
			result, err := s.allRepositories(q)
			if err != nil {
				return nil, err
			}
			return result.([]M), nil
		}
		assertList := func(query, name string, wantCalls int) {
			t.Helper()
			rows, err := list(query)
			if err != nil {
				t.Fatal(err)
			}
			want := []M{{"id": "gh_" + repoID, "fullName": name}}
			if !reflect.DeepEqual(rows, want) || calls != wantCalls {
				t.Fatalf("rows=%v calls=%d; want %v calls=%d", rows, calls, want, wantCalls)
			}
		}
		assertList("", "cache/original", 1)
		cached, err := s.Store.one(ctx, "repositories", M{"externalId": "gh_" + repoID})
		if err != nil {
			t.Fatal(err)
		}
		if cached["defaultBranch"] != "trunk" || number(cached["size"]) != 42 || cached["source"] != "github" {
			t.Fatalf("missing metadata: %v", cached)
		}
		body[0]["full_name"] = "cache/renamed"
		assertList("", "cache/original", 1)
		assertList("?force=true", "cache/original", 1)
		assertList("?force=1&force[]=1", "cache/original", 1)
		assertList("?force[]=1", "cache/renamed", 2)
		// TypeScript returns fresh metadata on refresh but reuses an existing
		// database row unchanged; the next cached read reflects that row.
		assertList("", "cache/original", 2)
		stored, err := s.Store.one(ctx, "users", M{"_id": owner})
		if err != nil {
			t.Fatal(err)
		}
		if len(arr(stored["repositories"])) != 1 || str(arr(stored["repositories"])[0]) != str(cached["_id"]) {
			t.Fatal("reference not reused")
		}
		status = 500
		if _, err := list("?force=1"); err == nil {
			t.Fatal("upstream failure swallowed")
		}
		status = 200
		assertList("", "cache/original", 3)
		grant()
		assertList("", "cache/renamed", 4)
		// A grant replacement during the upstream request must win over publication.
		duringFetch = grant
		if _, err := list("?force=1"); err == nil || err.Error() != "connection_changed" {
			t.Fatalf("stale publication accepted: %v", err)
		}
		duringFetch = nil
		stored, err = s.Store.one(ctx, "users", M{"_id": owner})
		if err != nil || len(arr(stored["repositories"])) != 0 {
			t.Fatal("invalidation overwritten", err)
		}
		body = []M{}
		for i := 0; i < 2; i++ {
			rows, err := list("")
			if err != nil || len(rows) != 0 {
				t.Fatal(rows, err)
			}
		}
		if calls != 7 {
			t.Fatalf("empty lists should refetch: %d", calls)
		}
		if _, err := s.Store.update(ctx, "users", M{"_id": owner}, M{"$set": M{"repositories": []any{bson.NewObjectID()}}}); err != nil {
			t.Fatal(err)
		}
		rows, err := list("")
		if err != nil || len(rows) != 0 || calls != 7 {
			t.Fatal("missing refs should be omitted without fetching", rows, err, calls)
		}
		foreignID := bson.NewObjectID()
		if _, err := s.Store.DB.Collection("repositories").InsertOne(ctx, M{"_id": foreignID, "externalId": "other-forge:opaque", "name": "private/other-forge"}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.update(ctx, "users", M{"_id": owner}, M{"$set": M{"repositories": []any{cached["_id"], foreignID, cached["_id"], bson.NewObjectID()}}}); err != nil {
			t.Fatal(err)
		}
		assertList("", "cache/original", 7)
	})
}
