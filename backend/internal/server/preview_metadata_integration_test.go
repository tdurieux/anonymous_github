package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runPreviewMetadataIntegration(t *testing.T, base *Server) {
	t.Run("GitHub preview metadata cache refresh and Pages output", func(t *testing.T) {
		ctx := context.Background()
		owner, key := bson.NewObjectID(), bson.NewObjectID()
		db := base.Store.DB.Client().Database("preview_metadata_" + owner.Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		s.Config.AppEnabled = false
		registry, err := provider.New(&githubProvider{s})
		if err != nil {
			t.Fatal(err)
		}
		s.providers = registry
		if err := s.Store.ensureIndexes(ctx); err != nil {
			t.Fatal(err)
		}
		user := M{"_id": owner, "username": "owner", "status": "active"}
		if _, err := db.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Collection("repositories").InsertOne(ctx, M{"_id": key, "externalId": "gh_42", "source": "github", "name": "team/project", "defaultBranch": "old-main", "size": 10, "hasPage": false}); err != nil {
			t.Fatal(err)
		}
		q := &request{Server: s, R: httptest.NewRequest("GET", "/", nil), W: httptest.NewRecorder(), Params: map[string]string{"owner": "team", "repo": "project"}, User: user, Identity: identity(user)}
		if err := s.saveGrant(q, owner, "github", M{"access_token": "synthetic-oauth-" + owner.Hex()}); err != nil {
			t.Fatal(err)
		}
		repoStatus, pageStatus, repoID, size := 200, 200, 42, 20
		hasPages := true
		pageBranch, pagePath := "docs", "/docs"
		repoCalls, pageCalls := 0, 0
		var duringRepository func()
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			if r.Header.Get("Authorization") != "Bearer synthetic-oauth-"+owner.Hex() {
				t.Fatal("wrong metadata credential")
			}
			var data M
			status := 200
			switch r.URL.Path {
			case "/repos/team/project":
				repoCalls++
				status = repoStatus
				data = M{"id": repoID, "full_name": "team/project", "size": size, "default_branch": "main", "has_pages": hasPages}
				if duringRepository != nil {
					duringRepository()
				}
			case "/repos/team/project/pages":
				pageCalls++
				status = pageStatus
				data = M{"source": M{"branch": pageBranch, "path": pagePath}}
			default:
				t.Fatal("unexpected metadata endpoint", r.URL)
			}
			b, _ := json.Marshal(data)
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(b)))}, nil
		})}
		call := func(query string) (M, error) {
			before := repoCalls
			q.R = httptest.NewRequest("GET", "/"+query, nil)
			result, err := s.sourceRepository("metadata")(q)
			if repoCalls != before+1 {
				t.Fatal("cache skipped current upstream access check")
			}
			if result == nil {
				return nil, err
			}
			return obj(result), err
		}
		for _, query := range []string{"", "?force=true", "?force=1&force=1", "?reconnect[]=1", "?reconnect=1&reconnect[]=1"} {
			result, err := call(query)
			if err != nil || number(result["size"]) != 10 || boolean(result["hasPage"]) || pageCalls != 0 {
				t.Fatal("ordinary preview refreshed cached fields", query, result, err)
			}
		}
		result, err := call("?force[]=1")
		if err != nil || number(result["size"]) != 20 || !boolean(result["hasPage"]) || obj(result["pageSource"])["branch"] != "docs" || obj(result["pageSource"])["path"] != "/docs" || pageCalls != 1 {
			t.Fatal("forced Pages metadata missing", result, err)
		}
		pageBranch, pagePath = "published", "/"
		result, err = call("?reconnect=1&force=0")
		if err != nil || obj(result["pageSource"])["branch"] != "published" || pageCalls != 2 {
			t.Fatal("reconnect did not refresh metadata", result, err)
		}
		for _, status := range []int{403, 404} {
			pageStatus = status
			size++
			result, err = call("?force=1")
			if err != nil || number(result["size"]) != int64(size) || obj(result["pageSource"])["branch"] != "published" {
				t.Fatal("optional Pages failure erased prior source", status, result, err)
			}
		}
		for _, status := range []int{401, 422, 503} {
			pageStatus = status
			_, err = call("?force=1")
			if err == nil {
				t.Fatal("Pages failure incorrectly ignored", status)
			}
			cached, err := s.Store.one(ctx, "repositories", M{"_id": key})
			if err != nil || number(cached["size"]) != 22 || obj(cached["pageSource"])["branch"] != "published" {
				t.Fatal("failed refresh changed cache", cached, err)
			}
		}
		pageStatus = 200
		beforePages := pageCalls
		for _, status := range []int{401, 403, 503} {
			repoStatus = status
			if result, err := call(""); err == nil || result != nil {
				t.Fatal("cached private metadata bypassed upstream denial", status, result, err)
			}
		}
		if pageCalls != beforePages {
			t.Fatal("Pages requested after upstream denial")
		}
		repoStatus = 200
		repoID = 43
		if _, err := call(""); err == nil || err.Error() != "connection_changed" {
			t.Fatal("cache hid changed upstream identity", err)
		}
		repoID = 42
		duringRepository = func() {
			if _, err := s.Store.update(ctx, "repositories", M{"_id": key}, M{"$set": M{"size": 77, "pageSource": M{"branch": "concurrent", "path": "/"}}}); err != nil {
				t.Fatal(err)
			}
		}
		result, err = call("")
		duringRepository = nil
		if err != nil || number(result["size"]) != 22 {
			t.Fatal("cached snapshot changed during request", result, err)
		}
		cached, err := s.Store.one(ctx, "repositories", M{"_id": key})
		if err != nil || number(cached["size"]) != 77 || obj(cached["pageSource"])["branch"] != "concurrent" {
			t.Fatal("cached preview overwrote newer metadata", cached, err)
		}
		hasPages = false
		result, err = call("?force=1")
		if err != nil || boolean(result["hasPage"]) || pageCalls != beforePages {
			t.Fatal("disabled Pages queried upstream", result, err)
		}
		if _, err := db.Collection("repositories").DeleteMany(ctx, M{}); err != nil {
			t.Fatal(err)
		}
		hasPages = true
		result, err = call("")
		if err != nil || obj(result["pageSource"])["branch"] != "published" || pageCalls != beforePages+1 {
			t.Fatal("cold preview did not load Pages metadata", result, err)
		}
		// Quota failures persist across calls. Exercise this last so the gate
		// does not suppress the independent upstream-error cases above.
		pageStatus = 429
		if _, err := call("?force=1"); err == nil {
			t.Fatal("Pages quota failure ignored")
		}
		before := repoCalls
		q.R = httptest.NewRequest("GET", "/?force=1", nil)
		if _, err := s.sourceRepository("metadata")(q); err == nil || repoCalls != before {
			t.Fatal("known quota gate dispatched another request", err)
		}
	})
}
