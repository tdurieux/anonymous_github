package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAccountRemovalIntegration(t *testing.T, base *Server) {
	t.Run("account removal scrubs tombstones despite upstream failure", func(t *testing.T) {
		ctx := context.Background()
		owner, other := bson.NewObjectID(), bson.NewObjectID()
		// Isolate maintenance side effects from other lifecycle fixtures.
		db := base.Store.DB.Client().Database("account_removal_" + owner.Hex())
		defer db.Drop(context.Background())
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}, content: base.content, providers: base.providers}
		s.Config.AppEnabled = true
		s.Config.ClientID = "fixture-oauth-client"
		s.Config.AppClientID = "fixture-app-client"
		user := M{"_id": owner, "username": "account-removal-fixture", "status": "active", "emails": []M{{"email": "fixture@example.test"}}, "apiTokens": []M{{"tokenHash": "synthetic"}}, "repositories": []any{bson.NewObjectID()}, "externalIDs": M{"github": "account-removal-fixture"}, "accessTokens": M{"github": "synthetic-legacy"}, "accessTokenDates": M{"github": time.Now()}, "photo": "fixture-avatar", "default": M{"terms": []string{"private"}}, "projectNames": M{"private": "name"}}
		if _, err := db.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		q := &request{Server: s, User: user, Identity: identity(user), SessionID: "account-removal-" + owner.Hex(), R: httptest.NewRequest("DELETE", "/api/user", nil), W: httptest.NewRecorder()}
		for _, provider := range []string{"github", "github-app-user"} {
			tokens := M{"access_token": "synthetic-delete-" + provider}
			if provider == "github-app-user" {
				tokens["refresh_token"] = "synthetic-refresh"
				tokens["expires_in"] = float64(3600)
				tokens["refresh_token_expires_in"] = float64(7200)
			}
			if err := s.saveGrant(q, owner, provider, tokens); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := db.Collection("credentials").InsertOne(ctx, M{"ownerId": owner, "provider": "other-forge", "encryptedToken": "synthetic-provider-credential"}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Collection("credentials").InsertOne(ctx, M{"ownerId": other, "provider": "github", "encryptedToken": "another-user-credential"}); err != nil {
			t.Fatal(err)
		}
		at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		for _, kind := range []string{"repo", "pr", "gist"} {
			for _, id := range []bson.ObjectID{owner, other} {
				if _, err := db.Collection(collection(kind)).InsertOne(ctx, M{"_id": bson.NewObjectID(), idKey(kind): "account-removal-" + id.Hex(), "owner": id, "status": "removed", "statusDate": at, "accessToken": "synthetic-top-secret", "source": M{"provider": "fixture", "accessToken": "synthetic-source-secret", "repositoryName": "private/project"}}); err != nil {
					t.Fatal(err)
				}
			}
		}
		if _, err := db.Collection("dashboardnames").InsertMany(ctx, []any{M{"owner": owner, "name": "private-name"}, M{"owner": other, "name": "other-name"}}); err != nil {
			t.Fatal(err)
		}
		installation := M{"appId": s.Config.AppID, "installationId": int64(912345), "accountLogin": "shared-organization", "blocked": false}
		if _, err := db.Collection("githubinstallations").InsertOne(ctx, installation); err != nil {
			t.Fatal(err)
		}
		key := "anoGH_session:" + q.SessionID
		if err := s.Store.Redis.Set(ctx, key, "synthetic-session", time.Minute).Err(); err != nil {
			t.Fatal(err)
		}
		defer s.Store.Redis.Del(context.Background(), key)
		calls := map[string]int{}
		s.HTTP = &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
			if req.Method != "DELETE" || !strings.HasSuffix(req.URL.Path, "/grant") || strings.Contains(req.URL.Path, "installations") {
				t.Fatal("unexpected revocation target", req.URL)
			}
			calls[req.URL.Path]++
			return &http.Response{StatusCode: 503, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("upstream unavailable"))}, nil
		})}
		result, err := s.deleteAccount(q)
		if err != nil || obj(result)["status"] != "ok" {
			t.Fatal("local removal failed", result, err)
		}
		if len(calls) != 2 {
			t.Fatal("both grants were not attempted", calls)
		}
		saved, err := s.Store.one(ctx, "users", M{"_id": owner})
		if err != nil {
			t.Fatal(err)
		}
		if saved["status"] != "removed" || saved["username"] != "deleted-"+owner.Hex() {
			t.Fatal("identity not tombstoned")
		}
		for _, field := range []string{"accessTokens", "accessTokenDates", "externalIDs", "photo", "default", "projectNames"} {
			if _, exists := saved[field]; exists {
				t.Fatal("personal field retained", field)
			}
		}
		for _, field := range []string{"emails", "apiTokens", "repositories"} {
			if len(arr(saved[field])) != 0 {
				t.Fatal("personal array retained", field)
			}
		}
		for _, kind := range []string{"repo", "pr", "gist"} {
			row, err := s.Store.one(ctx, collection(kind), M{"owner": owner})
			if err != nil {
				t.Fatal(err)
			}
			if row["accessToken"] != nil || obj(row["source"])["accessToken"] != nil {
				t.Fatal("tombstone retained a credential", kind)
			}
			if row["status"] != "removed" || !date(row["statusDate"]).Equal(at) {
				t.Fatal("tombstone lifecycle rewritten", kind)
			}
			otherRow, err := s.Store.one(ctx, collection(kind), M{"owner": other})
			if err != nil || otherRow["accessToken"] == nil || obj(otherRow["source"])["accessToken"] == nil {
				t.Fatal("another owner's source changed", kind, err)
			}
		}
		for _, collection := range []string{"credentials", "dashboardnames"} {
			field := "owner"
			if collection == "credentials" {
				field = "ownerId"
			}
			count, err := db.Collection(collection).CountDocuments(ctx, M{field: owner})
			if err != nil || count != 0 {
				t.Fatal("private records retained", collection, count, err)
			}
			count, err = db.Collection(collection).CountDocuments(ctx, M{field: other})
			if err != nil || count != 1 {
				t.Fatal("other owner changed", collection, count, err)
			}
		}
		shared, err := s.Store.one(ctx, "githubinstallations", M{"installationId": int64(912345)})
		if err != nil || shared["accountLogin"] != "shared-organization" || boolean(shared["blocked"]) {
			t.Fatal("shared installation changed", err)
		}
		if count, err := s.Store.Redis.Exists(ctx, key).Result(); err != nil || count != 0 {
			t.Fatal("session retained", err)
		}
	})
}
