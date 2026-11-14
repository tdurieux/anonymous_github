package server

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runGrantIntegration(t *testing.T, s *Server) {
	t.Run("grant replacement metadata", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		if _, err := s.Store.DB.Collection("users").InsertOne(ctx, M{"_id": owner, "username": "grant-replacement", "status": "active", "repositories": []any{"stale"}}); err != nil {
			t.Fatal(err)
		}
		q := &request{Server: s, R: httptest.NewRequest("GET", "/github/app/callback", nil)}
		for _, provider := range []string{"github-app-user", "github"} {
			if _, err := s.Store.DB.Collection("credentials").InsertOne(ctx, M{"ownerId": owner, "provider": provider, "revision": "old", "refreshLock": "old-lock", "refreshLockUntil": time.Now().Add(time.Hour), "encryptedRefreshToken": M{}, "expiresAt": time.Now().Add(-time.Hour), "refreshExpiresAt": time.Now().Add(-time.Hour)}); err != nil {
				t.Fatal(err)
			}
			tokens := M{"access_token": "synthetic-new-access"}
			if provider == "github-app-user" {
				tokens["refresh_token"] = "synthetic-new-refresh"
				tokens["expires_in"] = float64(3600)
				tokens["refresh_token_expires_in"] = float64(7200)
			}
			if err := s.saveGrant(q, owner, provider, tokens); err != nil {
				t.Fatal(err)
			}
			row, err := s.Store.one(ctx, "credentials", M{"ownerId": owner, "provider": provider})
			if err != nil {
				t.Fatal(err)
			}
			if row["refreshLock"] != nil || row["refreshLockUntil"] != nil || row["revision"] == "old" {
				t.Fatal("stale grant metadata retained")
			}
			envelope, err := envelope(row["encryptedToken"])
			if err != nil {
				t.Fatal(err)
			}
			plain, err := s.Config.Cipher.Decrypt(envelope, owner.Hex(), provider, "")
			if err != nil || plain != "synthetic-new-access" {
				t.Fatal("new credential not encrypted correctly", err)
			}
			if provider == "github" {
				if row["encryptedRefreshToken"] != nil || row["expiresAt"] != nil || row["refreshExpiresAt"] != nil {
					t.Fatal("OAuth replacement retained stale refresh fields")
				}
			} else {
				if !date(row["expiresAt"]).After(time.Now().Add(59*time.Minute)) || !date(row["refreshExpiresAt"]).After(time.Now().Add(119*time.Minute)) {
					t.Fatal("App expirations missing")
				}
				if err := s.saveGrant(q, owner, provider, M{"access_token": "synthetic-incomplete"}); err == nil {
					t.Fatal("partial App grant accepted")
				}
				unchanged, err := s.Store.one(ctx, "credentials", M{"ownerId": owner, "provider": provider})
				if err != nil || unchanged["revision"] != row["revision"] {
					t.Fatal("invalid grant replaced valid credential", err)
				}
			}
		}
		user, err := s.Store.one(ctx, "users", M{"_id": owner})
		if err != nil || len(arr(user["repositories"])) != 0 {
			t.Fatal("repository discovery cache not invalidated", err)
		}
	})
}
