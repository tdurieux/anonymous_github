package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAccessSelectionIntegration(t *testing.T, base *Server) {
	t.Run("access selection uses typed upstream identities", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		db := base.Store.DB.Client().Database("access_selection_" + owner.Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		s.Config.AppEnabled = true
		if _, err := db.Collection("users").InsertOne(ctx, M{"_id": owner, "username": owner.Hex(), "status": "active"}); err != nil {
			t.Fatal(err)
		}
		for _, choice := range []string{"", "oauth"} {
			if _, _, err := s.selectAccess(ctx, owner, "team/project", choice); err == nil || err.Error() != "github_oauth_required" {
				t.Fatal("wrong missing OAuth result", err)
			}
		}
		q := &request{Server: s, R: httptest.NewRequest("GET", "/", nil)}
		if err := s.saveGrant(q, owner, "github", M{"access_token": "synthetic-oauth"}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.update(ctx, "credentials", M{"ownerId": owner, "provider": "github"}, M{"$set": M{"revoked": true}}); err != nil {
			t.Fatal(err)
		}
		if token, binding, err := s.selectAccess(ctx, owner, "team/project", "oauth"); err != nil || token != "synthetic-oauth" || binding["kind"] != "oauth" {
			t.Fatal("stored OAuth selection differs", err)
		}
		if _, err := s.Store.update(ctx, "credentials", M{"ownerId": owner, "provider": "github"}, M{"$set": M{"encryptedToken": "corrupt"}}); err != nil {
			t.Fatal(err)
		}
		if _, _, err := s.selectAccess(ctx, owner, "team/project", "oauth"); err == nil || err.Error() != "credential_decryption_failed" {
			t.Fatal("corrupt OAuth grant accepted", err)
		}
		if err := s.saveGrant(q, owner, "github-app-user", M{"access_token": "synthetic-app", "refresh_token": "synthetic-refresh", "expires_in": float64(3600), "refresh_token_expires_in": float64(7200)}); err != nil {
			t.Fatal(err)
		}
		var upstreamID any
		repoCalls := 0
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			var response M
			switch r.URL.Path {
			case "/user/installations":
				response = M{"installations": []any{}}
			case "/repos/team/project":
				repoCalls++
				response = M{"id": upstreamID, "full_name": "team/project", "private": false, "visibility": "public"}
			default:
				t.Fatal("invalid binding reached an unexpected upstream endpoint", r.URL)
			}
			body, err := json.Marshal(response)
			if err != nil {
				t.Fatal(err)
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
		})}
		for _, id := range []any{nil, "42", true, 42.5, 9007199254740992.0, []any{42}, M{"id": 42}, float64(0), float64(-1), float64(42), float64(9007199254740991)} {
			upstreamID = id
			repoCalls = 0
			_, binding, err := s.selectAccess(ctx, owner, "team/project", "github-app")
			valid := jsonSafeInteger(id)
			if valid {
				if err != nil || !boolean(binding["publicRead"]) || str(binding["repositoryId"]) != str(id) || repoCalls != 2 {
					t.Fatal("valid public repository rejected", id, err, repoCalls)
				}
			} else if err == nil || err.Error() != "github_app_access_required" || repoCalls != 1 {
				t.Fatal("invalid upstream ID bound", id, err, repoCalls)
			}
		}
		for _, id := range []any{"42", 42.5, 9007199254740992.0, nil} {
			upstreamID = float64(42)
			repoCalls = 0
			_, err := s.boundToken(ctx, owner, M{"kind": "github-app", "publicRead": true, "repositoryId": id}, "team/project")
			if err == nil || repoCalls != 0 {
				t.Fatal("malformed stored identity reached upstream", id, err)
			}
		}
		for _, installation := range []any{nil, float64(42), "42"} {
			repoCalls = 0
			if _, err := s.boundToken(ctx, owner, M{"kind": "github-app", "publicRead": true, "repositoryId": int64(42), "installationId": installation}, "team/project"); err == nil || repoCalls != 0 {
				t.Fatal("public binding accepted installation field", installation, err)
			}
		}
		for _, id := range []any{"42", 42.5, float64(43)} {
			upstreamID = id
			if _, err := s.boundToken(ctx, owner, M{"kind": "github-app", "publicRead": true, "repositoryId": int64(42)}, "team/project"); err == nil {
				t.Fatal("public reauthorization accepted changed/coerced identity", id)
			}
		}
	})
}
