package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runUserListsIntegration(t *testing.T, s *Server) {
	t.Run("resource expiry recognizes zero date and epoch", func(t *testing.T) {
		ctx := context.Background()
		for _, kind := range []string{"repo", "gist", "pr"} {
			for _, expires := range []time.Time{time.Time{}, time.UnixMilli(0)} {
				row := M{"_id": bson.NewObjectID(), idKey(kind): "resource-expiry-" + kind + expires.Format("2006"), "status": "ready", "statusDate": time.Now().Add(-time.Hour), "options": M{"expirationMode": "date", "expirationDate": expires}}
				if _, err := s.Store.DB.Collection(collection(kind)).InsertOne(ctx, row); err != nil {
					t.Fatal(err)
				}
				stored, err := s.Store.one(ctx, collection(kind), M{"_id": row["_id"]})
				if err != nil {
					t.Fatal(err)
				}
				failure, ok := s.checkResource(ctx, kind, stored).(*APIError)
				if !ok || failure.Status != 410 {
					t.Fatalf("%s expiry was not enforced: %v", kind, failure)
				}
				stored, err = s.Store.one(ctx, collection(kind), M{"_id": row["_id"]})
				if err != nil || stored["status"] != "expiring" {
					t.Fatal(kind, stored, err)
				}
			}
		}
	})

	t.Run("user and admin lists share membership and expire overdue rows", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		other := bson.NewObjectID()
		token, adminToken := "synthetic-list-user", "synthetic-list-admin"
		for _, u := range []M{{"_id": owner, "username": "list-user", "externalIDs": M{"github": "9917000999"}, "status": "active", "apiTokens": []M{{"tokenHash": security.HashToken(token)}}}, {"_id": bson.NewObjectID(), "username": "list-admin", "status": "active", "isAdmin": true, "apiTokens": []M{{"tokenHash": security.HashToken(adminToken)}}}} {
			if _, err := s.Store.DB.Collection("users").InsertOne(ctx, u); err != nil {
				t.Fatal(err)
			}
		}
		call := func(path, auth string) []M {
			t.Helper()
			req := httptest.NewRequest("GET", path, nil)
			req.RemoteAddr = "198.51.100.17:1234"
			req.Header.Set("Authorization", "Bearer "+auth)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			if w.Code != 200 {
				t.Fatal(path, w.Code, w.Body)
			}
			var rows []M
			if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
				t.Fatal(err)
			}
			return rows
		}
		cases := []struct {
			name         string
			coauthors    []M
			own, visible bool
		}{
			{"owned", nil, true, true}, {"stable", []M{{"username": "renamed", "githubId": "9917000999"}}, false, true},
			{"legacy-missing", []M{{"username": "list-user"}}, false, true}, {"legacy-null", []M{{"username": "list-user", "githubId": nil}}, false, true}, {"legacy-empty", []M{{"username": "list-user", "githubId": ""}}, false, true},
			{"wrong-id", []M{{"username": "list-user", "githubId": "different"}}, false, false}, {"wrong-name", []M{{"username": "different"}}, false, false},
			{"split-fields", []M{{"username": "list-user", "githubId": "different"}, {"username": "other"}}, false, false},
		}
		expected := []string{}
		for _, c := range cases {
			rowOwner := other
			if c.own {
				rowOwner = owner
			}
			id := "list-membership-" + c.name
			if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, M{"_id": bson.NewObjectID(), "repoId": id, "owner": rowOwner, "coauthors": c.coauthors, "status": "ready", "options": M{"expirationMode": "never"}}); err != nil {
				t.Fatal(err)
			}
			if c.visible {
				expected = append(expected, id)
			}
		}
		sort.Strings(expected)
		for _, c := range []struct{ path, token string }{{"/api/user/anonymized_repositories", token}, {"/api/admin/users/list-user/repos", adminToken}} {
			got := []string{}
			for _, row := range call(c.path, c.token) {
				got = append(got, str(row["repoId"]))
			}
			sort.Strings(got)
			if !reflect.DeepEqual(got, expected) {
				t.Fatal(c.path, got, expected)
			}
		}
		before := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
		for kind, suffix := range map[string]string{"repo": "repositories", "gist": "gists", "pr": "pull_requests"} {
			type stateCase struct {
				name, status, mode, want string
				expires                  any
			}
			states := []stateCase{{"zero-date", "ready", "date", "expiring", time.Time{}}, {"epoch", "ready", "date", "expiring", time.UnixMilli(0)}, {"zero-never", "ready", "never", "ready", time.Time{}}, {"due", "ready", "date", "expiring", before}, {"never", "ready", "never", "ready", before}, {"future", "ready", "date", "ready", time.Now().Add(time.Hour)}, {"null", "ready", "date", "ready", nil}, {"expired", "expired", "date", "expired", before}, {"preparing", "preparing", "date", "preparing", before}, {"archived", "archived", "date", "archived", before}}
			for _, c := range states {
				if _, err := s.Store.DB.Collection(collection(kind)).InsertOne(ctx, M{"_id": bson.NewObjectID(), idKey(kind): "list-expiry-" + kind + "-" + c.name, "owner": owner, "status": c.status, "statusDate": before, "options": M{"expirationMode": c.mode, "expirationDate": c.expires}}); err != nil {
					t.Fatal(err)
				}
			}
			output := map[string]M{}
			for _, row := range call("/api/user/anonymized_"+suffix, token) {
				output[str(row[idKey(kind)])] = row
			}
			for _, c := range states {
				id := "list-expiry-" + kind + "-" + c.name
				if output[id]["status"] != c.want {
					t.Fatal(id, output[id], c.want)
				}
				stored, err := s.Store.one(ctx, collection(kind), M{idKey(kind): id})
				if err != nil {
					t.Fatal(err)
				}
				if stored["status"] != c.want {
					t.Fatal("not persisted", id, stored)
				}
				if c.want == "expiring" {
					if !date(stored["statusDate"]).After(before) {
						t.Fatal("missing expiry timestamp")
					}
				} else if !date(stored["statusDate"]).Equal(before) {
					t.Fatal("inactive timestamp changed", id)
				}
			}
		}
		// A stale list snapshot must return a concurrent extension rather than expire it.
		row, err := s.Store.one(ctx, collection("repo"), M{"repoId": "list-expiry-repo-due"})
		if err != nil {
			t.Fatal(err)
		}
		row["status"] = "ready"
		if _, err := s.Store.update(ctx, collection("repo"), M{"_id": row["_id"]}, M{"$set": M{"status": "ready", "options.expirationDate": time.Now().Add(time.Hour)}}); err != nil {
			t.Fatal(err)
		}
		fresh, err := s.markListExpired(ctx, "repo", []M{row})
		if err != nil || len(fresh) != 1 || fresh[0]["status"] != "ready" {
			t.Fatal("extension lost", fresh, err)
		}
		if _, err := s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"_id": row["_id"]}); err != nil {
			t.Fatal(err)
		}
		fresh, err = s.markListExpired(ctx, "repo", []M{row})
		if err != nil || len(fresh) != 0 {
			t.Fatal("deleted row retained", fresh, err)
		}
	})
}
