package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runDashboardNamesIntegration(t *testing.T, s *Server) {
	t.Run("dashboard names reconcile across batches", func(t *testing.T) {
		ctx := context.Background()
		owner, other := bson.NewObjectID(), bson.NewObjectID()
		names := M{}
		user := M{"_id": owner, "username": "dashboard-name-member", "externalIDs": M{"github": "dashboard-name-member-id"}, "projectNames": names}
		repos := []any{}
		existing := []any{}
		for i := 0; i < 601; i++ {
			id := fmt.Sprintf("name-recovery-%03d", i)
			names[projectNameKey("repo", id)] = fmt.Sprintf("Private %d", i)
			// Stable coauthor identity must survive a renamed account.
			repos = append(repos, M{"_id": bson.NewObjectID(), "repoId": id, "owner": other, "coauthors": []M{{"username": "former-login", "githubId": "dashboard-name-member-id"}}})
			if i < 301 {
				existing = append(existing, M{"owner": owner, "type": "repo", "artifactId": id, "name": "stale"})
			}
		}
		existing = append(existing, M{"owner": owner, "type": "repo", "artifactId": "orphan", "name": "removed private name"}, M{"owner": other, "type": "repo", "artifactId": "orphan", "name": "another user"})
		repos = append(repos, M{"_id": bson.NewObjectID(), "repoId": "name-recovery-forbidden", "owner": other})
		names[projectNameKey("repo", "name-recovery-forbidden")] = "must not backfill"
		if _, err := s.Store.DB.Collection(collection("repo")).InsertMany(ctx, repos); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.DB.Collection("dashboardnames").InsertMany(ctx, existing); err != nil {
			t.Fatal(err)
		}
		for _, kind := range []string{"pr", "gist"} {
			id := "name-recovery-" + kind
			names[projectNameKey(kind, id)] = kind + " private"
			if _, err := s.Store.DB.Collection(collection(kind)).InsertOne(ctx, M{"_id": bson.NewObjectID(), idKey(kind): id, "owner": owner}); err != nil {
				t.Fatal(err)
			}
		}
		q := &request{Server: s, User: user, R: httptest.NewRequest("GET", "/api/user/dashboard", nil)}
		for attempt := 0; attempt < 2; attempt++ {
			if err := s.ensureDashboardNames(q); err != nil {
				t.Fatal(err)
			}
			rows, err := s.Store.list(ctx, "dashboardnames", M{"owner": owner}, 0, nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(rows) != 603 {
				t.Fatalf("reconciled %d names; want 603", len(rows))
			}
			for _, row := range rows {
				want := names[projectNameKey(str(row["type"]), str(row["artifactId"]))]
				if row["name"] != want {
					t.Fatal("stale or unauthorized name", row)
				}
			}
		}
		filter := M{"owner": owner, "type": "repo", "artifactId": "name-recovery-000"}
		if _, err := s.Store.update(ctx, "dashboardnames", filter, M{"$set": M{"name": "cached interval"}}); err != nil {
			t.Fatal(err)
		}
		if err := s.ensureDashboardNames(q); err != nil {
			t.Fatal(err)
		}
		cached, err := s.Store.one(ctx, "dashboardnames", filter)
		if err != nil || cached["name"] != "cached interval" {
			t.Fatal("repeated request reconciled during TTL", err)
		}
		s.dashboardNames.clear()
		if err := s.ensureDashboardNames(q); err != nil {
			t.Fatal(err)
		}
		cached, err = s.Store.one(ctx, "dashboardnames", filter)
		if err != nil || cached["name"] != "Private 0" {
			t.Fatal("invalidation did not reconcile", err)
		}
		// An interrupted clear is recovered even when the authoritative map is empty.
		user["projectNames"] = M{}
		s.dashboardNames.clear()
		if err := s.ensureDashboardNames(q); err != nil {
			t.Fatal(err)
		}
		count, err := s.Store.DB.Collection("dashboardnames").CountDocuments(ctx, M{"owner": owner})
		if err != nil || count != 0 {
			t.Fatal("empty-map cleanup", count, err)
		}
		otherRow, err := s.Store.one(ctx, "dashboardnames", M{"owner": other, "artifactId": "orphan"})
		if err != nil || otherRow["name"] != "another user" {
			t.Fatal("modified another user's name", err)
		}
	})
}
