package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runProjectNamesIntegration(t *testing.T, s *Server) {
	t.Run("private project names and dashboard membership", func(t *testing.T) {
		ctx := context.Background()
		users := map[string]bson.ObjectID{}
		for _, name := range []string{"owner", "member", "admin"} {
			users[name] = bson.NewObjectID()
			if _, err := s.Store.DB.Collection("users").InsertOne(ctx, M{"_id": users[name], "username": "project-name-" + name, "status": "active", "isAdmin": name == "admin", "externalIDs": M{"github": "project-name-id-" + name}, "apiTokens": []M{{"tokenHash": security.HashToken("synthetic-project-name-" + name)}}}); err != nil {
				t.Fatal(err)
			}
		}
		for _, kind := range []string{"repo", "pr", "gist"} {
			if _, err := s.Store.DB.Collection(collection(kind)).InsertOne(ctx, M{"_id": bson.NewObjectID(), idKey(kind): "project-name-" + kind, "owner": users["owner"], "coauthors": []M{{"username": "old-member", "githubId": "project-name-id-member"}}, "status": "ready", "options": M{"expirationMode": "redirect", "expirationDate": time.Now().Add(-time.Hour)}}); err != nil {
				t.Fatal(err)
			}
		}
		call := func(actor, kind, id string, name any) *httptest.ResponseRecorder {
			body, _ := json.Marshal(M{"type": kind, "id": id, "name": name})
			req := httptest.NewRequest("POST", "/api/user/project-name", bytes.NewReader(body))
			req.RemoteAddr = "198.51.100.24:1234"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer synthetic-project-name-"+actor)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		for _, c := range []struct {
			actor, kind, id, name string
			code                  int
		}{
			{"owner", "repo", "project-name-repo", " Owner name ", 200},
			{"member", "repo", "project-name-repo", "Member name", 200},
			{"admin", "repo", "project-name-repo", "Admin name", 403},
			{"owner", "pr", "project-name-pr", "PR name", 200},
			{"member", "pr", "project-name-pr", "Forbidden", 403},
			{"admin", "pr", "project-name-pr", "Forbidden", 403},
			{"owner", "gist", "project-name-gist", "Gist name", 200},
			{"member", "gist", "project-name-gist", "Forbidden", 403},
			{"owner", "repo", "PROJECT-NAME-REPO", "Wrong case", 403},
			{"owner", "repo", "missing-project", "Missing", 403},
		} {
			s.dashboardNames.run(ctx, "invalidation-sentinel", func() error { return nil })
			w := call(c.actor, c.kind, c.id, c.name)
			if w.Code != c.code {
				t.Fatal(c, w.Code, w.Body)
			}
			recalculated := false
			s.dashboardNames.run(ctx, "invalidation-sentinel", func() error { recalculated = true; return nil })
			if recalculated != (c.code == 200) {
				t.Fatal("project-name cache invalidation", c, recalculated)
			}
		}
		key := projectNameKey("repo", "project-name-repo")
		for actor, want := range map[string]string{"owner": "Owner name", "member": "Member name", "admin": ""} {
			user, err := s.Store.one(ctx, "users", M{"_id": users[actor]})
			if err != nil {
				t.Fatal(err)
			}
			if str(obj(user["projectNames"])[key]) != want {
				t.Fatal("private names crossed users", actor, user["projectNames"])
			}
			cached, err := s.Store.one(ctx, "dashboardnames", M{"owner": users[actor], "type": "repo", "artifactId": "project-name-repo"})
			if err != nil {
				t.Fatal(err)
			}
			if str(cached["name"]) != want {
				t.Fatal("dashboard name mismatch", actor, cached)
			}
		}
		for _, kind := range []string{"repo", "pr", "gist"} {
			row, err := s.Store.one(ctx, collection(kind), M{idKey(kind): "project-name-" + kind})
			if err != nil {
				t.Fatal(err)
			}
			if row["status"] != "expiring" || row["projectName"] != nil {
				t.Fatal("list expiry or private-name isolation", row)
			}
		}
		if w := call("owner", "repo", "project-name-repo", false); w.Code != 400 {
			t.Fatal("non-string accepted", w.Code)
		}
		if w := call("owner", "repo", "project-name-repo", "\ufeff \ufeff"); w.Code != 200 {
			t.Fatal("clear failed", w.Code, w.Body)
		}
		user, err := s.Store.one(ctx, "users", M{"_id": users["owner"]})
		if err != nil {
			t.Fatal(err)
		}
		if _, exists := obj(user["projectNames"])[key]; exists {
			t.Fatal("clear retained private map entry")
		}
		cached, err := s.Store.one(ctx, "dashboardnames", M{"owner": users["owner"], "type": "repo", "artifactId": "project-name-repo"})
		if err != nil || cached != nil {
			t.Fatal("clear retained dashboard entry", err)
		}
	})
}
