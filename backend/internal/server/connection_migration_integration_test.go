package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runConnectionMigrationIntegration(t *testing.T, base *Server) {
	t.Run("connection migration preserves immutable identity and concurrent bindings", func(t *testing.T) {
		ctx := context.Background()
		db := base.Store.DB.Client().Database("connection_migration_" + bson.NewObjectID().Hex())
		defer db.Drop(ctx)
		for _, scenario := range []string{"rename", "preview", "replacement", "stale-pr", "fresh-pr", "changed-binding", "changed-status-date", "wrong-id-type"} {
			t.Run(scenario, func(t *testing.T) {
				owner, cached := bson.NewObjectID(), bson.NewObjectID()
				s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
				s.Config.AppEnabled = true
				s.Config.AppNewConnections = true
				user := M{"_id": owner, "username": owner.Hex(), "status": "active"}
				if _, err := db.Collection("users").InsertOne(ctx, user); err != nil {
					t.Fatal(err)
				}
				req := httptest.NewRequest("POST", "/github/connections/migrate", nil)
				req.Header.Set("X-CSRF-Token", "synthetic-csrf")
				q := &request{Server: s, User: user, R: req, W: httptest.NewRecorder(), Session: M{"githubConnectionCSRF": "synthetic-csrf"}}
				if err := s.saveGrant(q, owner, "github-app-user", M{"access_token": "synthetic-app-token", "refresh_token": "synthetic-refresh", "expires_in": float64(3600), "refresh_token_expires_in": float64(7200)}); err != nil {
					t.Fatal(err)
				}
				kind, typ, nameField := "repo", "repository", "repositoryName"
				if strings.Contains(scenario, "pr") && scenario != "preview" || scenario == "changed-status-date" {
					kind, typ, nameField = "pr", "pull-request", "repositoryFullName"
				}
				status := "ready"
				statusDate := time.Now().Add(-10 * time.Minute)
				if kind == "pr" {
					status = "download"
				}
				if scenario == "fresh-pr" {
					statusDate = time.Now()
				}
				id := owner.Hex()
				// Ordered source and binding documents catch embedded-document equality bugs.
				source := bson.D{{Key: nameField, Value: "old/project"}, {Key: "provider", Value: "github"}, {Key: "commit", Value: strings.Repeat("a", 40)}, {Key: "pullRequestId", Value: int64(7)}, {Key: "repositoryId", Value: cached}}
				binding := bson.D{{Key: "publicRead", Value: true}, {Key: "repositoryId", Value: int64(10)}, {Key: "kind", Value: "github-app"}, {Key: "revision", Value: "original"}}
				if _, err := db.Collection(collection(kind)).InsertOne(ctx, M{idKey(kind): id, "owner": owner, "status": status, "statusDate": statusDate, "source": source, "githubAccess": binding}); err != nil {
					t.Fatal(err)
				}
				if _, err := db.Collection("repositories").InsertOne(ctx, M{"_id": cached, "externalId": "gh_10", "name": "old/project", "url": "https://github.com/old/project"}); err != nil {
					t.Fatal(err)
				}
				q.Body = M{"type": typ, "id": id, "connection": "github-app", "preview": scenario == "preview"}
				if scenario == "wrong-id-type" {
					q.Body["id"] = 123
				}
				calls := 0
				s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
					calls++
					var data M
					switch {
					case r.URL.Path == "/user/installations":
						data = M{"installations": []any{}}
					case r.URL.Path == "/repositories/10" || r.URL.Path == "/repos/new/project":
						repositoryID := 10
						if scenario == "replacement" {
							repositoryID = 11
						}
						data = M{"id": repositoryID, "full_name": "new/project", "private": false, "visibility": "public"}
					case strings.HasPrefix(r.URL.Path, "/repos/new/project/commits/") || r.URL.Path == "/repos/new/project/pulls/7":
						data = M{"id": 7}
						if scenario == "changed-binding" {
							// Preserve the revision to ensure the full binding is compared.
							if _, err := s.Store.update(ctx, collection(kind), M{idKey(kind): id}, M{"$set": M{"githubAccess.repositoryId": int64(99)}}); err != nil {
								t.Fatal(err)
							}
						}
						if scenario == "changed-status-date" {
							if _, err := s.Store.update(ctx, collection(kind), M{idKey(kind): id}, M{"$set": M{"statusDate": time.Now()}}); err != nil {
								t.Fatal(err)
							}
						}
					default:
						t.Fatal("migration followed old/replacement name", r.URL)
					}
					body, err := json.Marshal(data)
					if err != nil {
						t.Fatal(err)
					}
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
				})}
				_, err := s.connections(q)
				expected := ""
				switch scenario {
				case "replacement", "changed-binding", "changed-status-date":
					expected = "connection_changed"
				case "fresh-pr":
					expected = "repository_busy"
				case "wrong-id-type":
					expected = "invalid_connection"
				}
				if expected == "" && err != nil || expected != "" && (err == nil || err.Error() != expected) {
					t.Fatal("unexpected migration result", err, expected)
				}
				if (scenario == "fresh-pr" || scenario == "wrong-id-type") && calls != 0 {
					t.Fatal("invalid migration contacted GitHub")
				}
				saved, err := s.Store.one(ctx, collection(kind), M{idKey(kind): id})
				if err != nil {
					t.Fatal(err)
				}
				metadata, err := s.Store.one(ctx, "repositories", M{"_id": cached})
				if err != nil {
					t.Fatal(err)
				}
				applied := expected == "" && scenario != "preview"
				if applied {
					if obj(saved["source"])[nameField] != "new/project" || number(obj(saved["githubAccess"])["repositoryId"]) != 10 || obj(saved["githubAccess"])["revision"] == "original" {
						t.Fatal("rename or binding not saved", saved)
					}
					if kind == "repo" && (metadata["name"] != "new/project" || metadata["url"] != "https://github.com/new/project") {
						t.Fatal("shared identity metadata not renamed", metadata)
					}
				} else {
					if obj(saved["source"])[nameField] != "old/project" {
						t.Fatal("preview/failure changed source")
					}
					if scenario == "preview" && (metadata["name"] != "old/project" || obj(saved["githubAccess"])["revision"] != "original") {
						t.Fatal("preview wrote state")
					}
					if scenario == "changed-binding" && number(obj(saved["githubAccess"])["repositoryId"]) != 99 {
						t.Fatal("concurrent binding overwritten")
					}
				}
			})
		}
	})
}
