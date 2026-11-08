package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runGrantRevocationIntegration(t *testing.T, base *Server) {
	t.Run("grant revocation uses stored tokens without refresh", func(t *testing.T) {
		ctx := context.Background()
		for _, provider := range []string{"github", "github-app-user"} {
			for _, status := range []int{199, 200, 204, 299, 302, 400, 401, 404, 422, 429, 500, 503, 0, -1} {
				owner := bson.NewObjectID()
				s := &Server{Config: base.Config, Store: base.Store}
				s.Config.AppEnabled = false
				user := M{"_id": owner, "username": "revocation-" + owner.Hex(), "status": "active", "repositories": []any{"stale"}, "accessTokens": M{"github": "legacy"}, "accessTokenDates": M{"github": time.Now()}}
				if _, err := s.Store.DB.Collection("users").InsertOne(ctx, user); err != nil {
					t.Fatal(err)
				}
				token := "synthetic-revocation-token"
				if status != -1 {
					q := &request{Server: s, R: httptest.NewRequest("GET", "/", nil)}
					tokens := M{"access_token": token}
					if provider == "github-app-user" {
						tokens["refresh_token"] = "must-not-refresh"
						tokens["expires_in"] = float64(3600)
						tokens["refresh_token_expires_in"] = float64(7200)
					}
					if err := s.saveGrant(q, owner, provider, tokens); err != nil {
						t.Fatal(err)
					}
					if _, err := s.Store.update(ctx, "credentials", M{"ownerId": owner, "provider": provider}, M{"$set": M{"expiresAt": time.Now().Add(-time.Hour), "refreshExpiresAt": time.Now().Add(-time.Hour), "revoked": true}}); err != nil {
						t.Fatal(err)
					}
					if _, err := s.Store.update(ctx, "users", M{"_id": owner}, M{"$set": M{"repositories": []any{"stale"}}}); err != nil {
						t.Fatal(err)
					}
				}
				calls := 0
				closed := false
				s.HTTP = &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
					calls++
					if deadline, ok := req.Context().Deadline(); !ok || time.Until(deadline) > 20*time.Second {
						t.Fatal("missing revocation deadline")
					}
					client, secret := s.Config.ClientID, s.Config.ClientSecret
					if provider == "github-app-user" {
						client, secret = s.Config.AppClientID, s.Config.AppClientSecret
					}
					actualClient, actualSecret, ok := req.BasicAuth()
					if !ok || actualClient != client || actualSecret != secret {
						t.Fatal("wrong revocation client")
					}
					if req.Method != "DELETE" || !strings.HasSuffix(req.URL.Path, "/grant") {
						t.Fatal("attempted token refresh or wrong endpoint")
					}
					var body M
					if err := json.NewDecoder(req.Body).Decode(&body); err != nil || body["access_token"] != token {
						t.Fatal("wrong revocation body", err)
					}
					if status == 0 {
						return nil, errors.New("synthetic upstream failure")
					}
					return &http.Response{StatusCode: status, Header: http.Header{}, Body: &revocationBody{Reader: strings.NewReader("synthetic upstream body"), closed: &closed}}, nil
				})}
				err := s.revokeGrant(ctx, owner, provider)
				success := status == -1 || status >= 200 && status < 300 || status == 404 || status == 422
				if (err == nil) != success {
					t.Fatal(provider, status, err)
				}
				if !success {
					var api *APIError
					if !errors.As(err, &api) || api.Code != "github_grant_revocation_failed" || api.Status != 502 {
						t.Fatal("unstable failure", err)
					}
				}
				if status == -1 {
					if calls != 0 {
						t.Fatal("missing grant contacted upstream")
					}
				} else if calls != 1 {
					t.Fatal("unexpected upstream calls", calls)
				}
				if status > 0 && !closed {
					t.Fatal("response body leaked")
				}
				saved, err := s.Store.one(ctx, "users", M{"_id": owner})
				if err != nil {
					t.Fatal(err)
				}
				credential, err := s.Store.one(ctx, "credentials", M{"ownerId": owner, "provider": provider})
				if err != nil {
					t.Fatal(err)
				}
				if success {
					if credential != nil || len(arr(saved["repositories"])) != 0 {
						t.Fatal("local disconnect incomplete")
					}
					if provider == "github" && (obj(saved["accessTokens"])["github"] != nil || obj(saved["accessTokenDates"])["github"] != nil) {
						t.Fatal("legacy OAuth grant retained")
					}
					if provider == "github-app-user" && obj(saved["accessTokens"])["github"] != "legacy" {
						t.Fatal("App disconnect changed OAuth grant")
					}
				} else if credential == nil || len(arr(saved["repositories"])) != 1 {
					t.Fatal("failed revocation discarded local grant")
				}
			}
		}
	})
}

type revocationBody struct {
	io.Reader
	closed *bool
}

func (b *revocationBody) Close() error { *b.closed = true; return nil }
