package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runCoauthorsIntegration(t *testing.T, s *Server) {
	t.Run("coauthor method permissions", func(t *testing.T) {
		ctx := context.Background()
		users := map[string]bson.ObjectID{}
		for _, name := range []string{"owner", "admin", "member", "stranger", "legacy"} {
			id := bson.NewObjectID()
			users[name] = id
			if _, err := s.Store.DB.Collection("users").InsertOne(ctx, M{"_id": id, "username": "coauthor-" + name, "status": "active", "isAdmin": name == "admin", "externalIDs": M{"github": "coauthor-id-" + name}, "apiTokens": []M{{"tokenHash": security.HashToken("synthetic-coauthor-" + name)}}}); err != nil {
				t.Fatal(err)
			}
		}
		id := bson.NewObjectID()
		original := bson.A{
			bson.D{{Key: "photo", Value: "avatar"}, {Key: "githubId", Value: "coauthor-id-member"}, {Key: "username", Value: "old-member-name"}},
			bson.D{{Key: "username", Value: "COAUTHOR-LEGACY"}},
		}
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, M{"_id": id, "repoId": "coauthor-permissions", "owner": users["owner"], "status": "removed", "coauthors": original}); err != nil {
			t.Fatal(err)
		}
		baseline, err := s.Store.one(ctx, collection("repo"), M{"_id": id})
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range []struct {
			name, method, actor, target string
			status                      int
			remaining                   int
		}{
			{"owner reads removed repository", "GET", "owner", "", 200, 2},
			{"stable ID reads", "GET", "member", "", 200, 2},
			{"stranger read denied", "GET", "stranger", "", 403, 2},
			{"legacy read is case sensitive", "GET", "legacy", "", 403, 2},
			{"stranger add denied", "POST", "stranger", "", 401, 2},
			{"member add denied", "POST", "member", "", 401, 2},
			{"owner empty add", "POST", "owner", "", 400, 2},
			{"admin empty add", "POST", "admin", "", 400, 2},
			{"member cannot remove absent stranger", "DELETE", "member", "absent", 401, 2},
			{"stranger cannot remove member", "DELETE", "stranger", "old-member-name", 401, 2},
			{"stable ID self removal", "DELETE", "member", "OLD-MEMBER-NAME", 200, 1},
			{"legacy self removal ignores case", "DELETE", "legacy", "coauthor-legacy", 200, 1},
			{"absent self removal is idempotent", "DELETE", "stranger", "COAUTHOR-STRANGER", 200, 2},
			{"owner removal", "DELETE", "owner", "old-member-name", 200, 1},
			{"admin removal", "DELETE", "admin", "old-member-name", 200, 1},
		} {
			t.Run(c.name, func(t *testing.T) {
				if _, err := s.Store.update(ctx, collection("repo"), M{"_id": id}, M{"$set": M{"coauthors": original}}); err != nil {
					t.Fatal(err)
				}
				path := "/api/repo/COAUTHOR-PERMISSIONS/coauthors"
				if c.target != "" {
					path += "/" + c.target
				}
				req := httptest.NewRequest(c.method, path, bytes.NewBufferString(`{}`))
				req.RemoteAddr = "198.51.100.22:1234"
				req.Header.Set("Authorization", "Bearer synthetic-coauthor-"+c.actor)
				req.Header.Set("Content-Type", "application/json")
				w := httptest.NewRecorder()
				s.ServeHTTP(w, req)
				if w.Code != c.status {
					t.Fatalf("%d %s", w.Code, w.Body)
				}
				saved, err := s.Store.one(ctx, collection("repo"), M{"_id": id})
				if err != nil {
					t.Fatal(err)
				}
				if len(arr(saved["coauthors"])) != c.remaining {
					t.Fatal("unexpected saved list", saved["coauthors"])
				}
				if c.status == 200 {
					var response any
					if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(response, defaultsJSON(t, saved["coauthors"])) {
						t.Fatal("response differs from persisted list", response)
					}
				} else if !reflect.DeepEqual(defaultsJSON(t, saved["coauthors"]), defaultsJSON(t, baseline["coauthors"])) {
					t.Fatal("denied operation mutated list")
				}
			})
		}
	})
}
