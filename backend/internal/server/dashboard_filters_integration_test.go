package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runDashboardFiltersIntegration(t *testing.T, s *Server) {
	t.Run("dashboard search and repeated query values", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		token := "synthetic-dashboard-filters"
		if _, err := s.Store.DB.Collection("users").InsertOne(ctx, M{"_id": owner, "username": "dashboard-filter-fixture", "status": "active", "apiTokens": []M{{"tokenHash": security.HashToken(token)}}}); err != nil {
			t.Fatal(err)
		}
		for _, r := range []struct{ id, status, source string }{
			{"filter-long", "ready", strings.Repeat("é", 256)},
			{"filter-short", "error", strings.Repeat("é", 200)},
			{"filter-literal", "removed", "[x].*"},
			{"filter-split", "preparing", strings.Repeat("a", 255) + "\ufffd"},
		} {
			if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, M{"_id": bson.NewObjectID(), "repoId": r.id, "owner": owner, "status": r.status, "anonymizeDate": time.Now(), "source": M{"provider": "fixture", "repositoryName": r.source}, "options": M{"expirationMode": "never"}}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := s.Store.DB.Collection(collection("gist")).InsertOne(ctx, M{"_id": bson.NewObjectID(), "gistId": "filter-gist", "owner": owner, "status": "ready", "source": M{"gistId": "first,second"}, "options": M{"expirationMode": "never"}}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.DB.Collection(collection("pr")).InsertOne(ctx, M{"_id": bson.NewObjectID(), "pullRequestId": "filter-pr", "owner": owner, "status": "ready", "source": M{"repositoryFullName": "first-only", "pullRequestId": 1}, "options": M{"expirationMode": "never"}}); err != nil {
			t.Fatal(err)
		}
		for _, c := range []struct {
			query  url.Values
			count  int
			id     string
			status int
		}{
			{url.Values{}, 5, "", 200},
			{url.Values{"q": {strings.Repeat("é", 256) + "truncated"}}, 1, "filter-long", 200},
			{url.Values{"q": {strings.Repeat("a", 255) + "😀"}}, 1, "filter-split", 200},
			{url.Values{"q": {"[x].*"}, "statuses": {"removed"}}, 1, "filter-literal", 200},
			{url.Values{"q": {"first", "second"}}, 1, "filter-gist", 200},
			{url.Values{"q": {"\ufefffirst,second\ufeff"}}, 1, "filter-gist", 200},
			{url.Values{"q": {"\u0085first,second\u0085"}}, 0, "", 200},
			{url.Values{"statuses": {"ready", "removed"}}, 4, "", 200},
			{url.Values{"statuses": {"", ""}}, 0, "", 200},
			{url.Values{"attention": {"true"}}, 1, "filter-short", 200},
			{url.Values{"attention": {"true", "true"}}, 5, "", 200},
			{url.Values{"type": {"repo", "gist"}}, 5, "", 200},
			{url.Values{"sort": {"_name", "_label"}}, 0, "", 400},
			{url.Values{"q[]": {"first", "second"}}, 1, "filter-gist", 200},
			{url.Values{"q[1]": {"second"}, "q[0]": {"first"}}, 1, "filter-gist", 200},
			{url.Values{"q[]": {"first,second"}, "limit[]": {"1"}}, 1, "filter-gist", 200},
			{url.Values{"statuses[]": {""}}, 0, "", 200},
			{url.Values{"statuses[]": {"ready", "removed"}}, 4, "", 200},
			{url.Values{"type[]": {"repo"}}, 0, "", 200},
			{url.Values{"attention[]": {"true"}}, 5, "", 200},
			{url.Values{"sort[]": {""}}, 0, "", 400},
			{url.Values{"cursor[]": {""}}, 0, "", 400},
			{url.Values{"cursor[toString]": {"invalid"}}, 0, "", 400},
			{url.Values{"q[toString]": {"invalid"}}, 0, "", 500},
		} {
			req := httptest.NewRequest("GET", "/api/user/dashboard?"+c.query.Encode(), nil)
			req.RemoteAddr = "198.51.100.26:1234"
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			if w.Code != c.status {
				t.Fatal(c.query, w.Code, w.Body)
			}
			if c.status != 200 {
				continue
			}
			var result M
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			items := arr(result["items"])
			if len(items) != c.count || number(result["filtered"]) != int64(c.count) || number(result["total"]) != 6 {
				t.Fatal(c.query, result)
			}
			if c.id != "" && obj(items[0])["_anonymousId"] != c.id {
				t.Fatal("wrong search result", c.query, result)
			}
		}
	})
}
