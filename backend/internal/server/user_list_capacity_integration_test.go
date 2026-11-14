package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runUserListCapacityIntegration(t *testing.T, s *Server) {
	t.Run("resource lists exceed legacy Go cap", func(t *testing.T) {
		ctx := context.Background()
		owner, other := bson.NewObjectID(), bson.NewObjectID()
		prefix := "list-capacity-" + owner.Hex()
		user := M{"_id": owner, "username": prefix, "status": "active", "externalIDs": M{"github": prefix}, "projectNames": M{}}
		const count = 10001
		for _, kind := range []string{"repo", "pr", "gist"} {
			obj(user["projectNames"])[projectNameKey(kind, fmt.Sprintf("%s-%s-%05d", prefix, kind, count-1))] = "Last private name"
		}
		if _, err := s.Store.DB.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		defer func() {
			for _, kind := range []string{"repo", "pr", "gist"} {
				s.Store.DB.Collection(collection(kind)).DeleteMany(context.Background(), M{"capacityFixture": prefix})
			}
			s.Store.DB.Collection("users").DeleteOne(context.Background(), M{"_id": owner})
		}()
		q := &request{Server: s, User: user, Identity: identity(user), R: httptest.NewRequest("GET", "/", nil), Params: map[string]string{"username": prefix}}
		for _, kind := range []string{"repo", "pr", "gist"} {
			t.Run(kind, func(t *testing.T) {
				records := make([]any, 0, count)
				for i := 0; i < count; i++ {
					row := M{"_id": bson.NewObjectID(), idKey(kind): fmt.Sprintf("%s-%s-%05d", prefix, kind, i), "owner": owner, "status": "error", "capacityFixture": prefix, "source": M{"provider": "fixture"}}
					if i == count-1 {
						row["status"] = "ready"
						row["options"] = M{"expirationMode": "redirect", "expirationDate": time.Now().Add(-time.Hour)}
						if kind == "repo" {
							row["owner"] = other
							row["coauthors"] = []M{{"username": "prior-login", "githubId": prefix}}
						}
					}
					records = append(records, row)
				}
				if _, err := s.Store.DB.Collection(collection(kind)).InsertMany(ctx, records); err != nil {
					t.Fatal(err)
				}
				result, err := s.userResources(kind)(q)
				if err != nil {
					t.Fatal(err)
				}
				rows := result.([]M)
				if len(rows) != count {
					t.Fatalf("returned %d rows; want %d", len(rows), count)
				}
				lastID := fmt.Sprintf("%s-%s-%05d", prefix, kind, count-1)
				seen := map[string]bool{}
				for _, row := range rows {
					id := str(row[idKey(kind)])
					if seen[id] {
						t.Fatal("duplicate", id)
					}
					seen[id] = true
					if id == lastID {
						if row["status"] != "expiring" || row["projectName"] != "Last private name" {
							t.Fatal("tail record lost expiry or private name", row)
						}
						if kind == "repo" && row["role"] != "coauthor" {
							t.Fatal("tail membership role", row)
						}
					}
				}
				if !seen[lastID] {
					t.Fatal("tail record omitted")
				}
				saved, err := s.Store.one(ctx, collection(kind), M{idKey(kind): lastID})
				if err != nil || saved["status"] != "expiring" {
					t.Fatal("tail expiry not persisted", err)
				}
				if kind == "repo" {
					result, err := s.adminUser("repos")(q)
					if err != nil {
						t.Fatal(err)
					}
					adminRows := result.([]M)
					if len(adminRows) != count {
						t.Fatalf("admin list returned %d rows", len(adminRows))
					}
					found := false
					for _, row := range adminRows {
						if row["repoId"] == lastID {
							found = true
						}
					}
					if !found {
						t.Fatal("admin list omitted coauthor tail")
					}
				}
				if _, err := s.Store.DB.Collection(collection(kind)).DeleteMany(ctx, M{"capacityFixture": prefix}); err != nil {
					t.Fatal(err)
				}
			})
		}
	})
}
