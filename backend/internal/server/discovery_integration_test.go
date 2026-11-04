package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runDiscoveryIntegration(t *testing.T, base *Server) {
	t.Run("GitHub discovery connection parity", func(t *testing.T) {
		for _, c := range []struct {
			name       string
			oauth, app bool
			failure    string
			want       []string
			wantError  bool
		}{
			{"OAuth only", true, false, "", []string{"legacy/one", "legacy/two"}, false},
			{"App only", false, true, "", []string{"app/two", "app/three"}, false},
			{"combined order and replacement", true, true, "", []string{"legacy/one", "app/two", "app/three"}, false},
			{"installation failure fallback", true, true, "/user/installations", []string{"legacy/one", "legacy/two"}, false},
			{"repository failure fallback", true, true, "/user/installations/1/repositories", []string{"legacy/one", "legacy/two"}, false},
			{"discard partial App results", true, true, "/user/installations/2/repositories", []string{"legacy/one", "legacy/two"}, false},
			{"App failure without OAuth", false, true, "/user/installations/2/repositories", nil, true},
			{"OAuth failure remains fatal", true, true, "/user/repos", nil, true},
		} {
			t.Run(c.name, func(t *testing.T) {
				ctx := context.Background()
				owner := bson.NewObjectID()
				if _, err := base.Store.DB.Collection("users").InsertOne(ctx, M{"_id": owner, "username": "discovery-" + owner.Hex(), "status": "active"}); err != nil {
					t.Fatal(err)
				}
				s := &Server{Config: base.Config, Store: base.Store}
				s.Config.AppEnabled = true
				s.Config.AppID = "12345"
				q := &request{Server: s, R: httptest.NewRequest("GET", "/", nil)}
				if c.oauth {
					if err := s.saveGrant(q, owner, "github", M{"access_token": "synthetic-discovery-oauth"}); err != nil {
						t.Fatal(err)
					}
				}
				if c.app {
					if err := s.saveGrant(q, owner, "github-app-user", M{"access_token": "synthetic-discovery-app", "refresh_token": "synthetic-refresh", "expires_in": float64(3600), "refresh_token_expires_in": float64(7200)}); err != nil {
						t.Fatal(err)
					}
				}
				oauthCalls := 0
				s.HTTP = &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
					path := req.URL.Path
					expectedToken := "synthetic-discovery-app"
					if path == "/user/repos" {
						oauthCalls++
						expectedToken = "synthetic-discovery-oauth"
						wantSort := "pushed"
						if c.app {
							wantSort = ""
						}
						if req.URL.Query().Get("sort") != wantSort {
							t.Fatalf("unexpected sort: %s", req.URL)
						}
					}
					if !strings.HasSuffix(req.Header.Get("Authorization"), expectedToken) {
						t.Fatal("wrong connection credential")
					}
					if req.URL.Query().Get("per_page") != "100" || req.URL.Query().Get("page") != "1" {
						t.Fatalf("unexpected pagination: %s", req.URL)
					}
					status := 200
					var body any
					if path == c.failure {
						status = 500
						body = M{"message": "synthetic private upstream detail"}
					} else {
						switch path {
						case "/user/installations":
							body = M{"installations": []M{
								{"id": 1, "app_id": 12345, "suspended_at": nil},
								{"id": 2, "app_id": 12345, "suspended_at": ""},
								{"id": 3, "app_id": 12345, "suspended_at": "2026-01-01"},
								{"id": 4, "app_id": 54321, "suspended_at": nil},
							}}
						case "/user/installations/1/repositories":
							body = M{"repositories": []M{{"id": 2, "full_name": "app/two"}}}
						case "/user/installations/2/repositories":
							body = M{"repositories": []M{{"id": 3, "full_name": "app/three"}}}
						case "/user/repos":
							body = []M{{"id": 1, "full_name": "legacy/one"}, {"id": 2, "full_name": "legacy/two"}}
						default:
							t.Fatalf("unexpected upstream request %s", req.URL)
						}
					}
					raw, err := json.Marshal(body)
					if err != nil {
						t.Fatal(err)
					}
					return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
				})}
				adapter := &githubProvider{server: s}
				repos, err := adapter.List(ctx, provider.ListRequest{OwnerID: owner.Hex()})
				if c.wantError {
					var api *APIError
					if !errors.As(err, &api) || strings.Contains(err.Error(), "private upstream") {
						t.Fatalf("unexpected discovery error: %v", err)
					}
					if len(repos) != 0 {
						t.Fatal("returned partial discovery on failure")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				names := []string{}
				for _, r := range repos {
					names = append(names, r.Name)
				}
				if !reflect.DeepEqual(names, c.want) {
					t.Fatalf("repositories %v; want %v", names, c.want)
				}
				wantOAuthCalls := 1
				if c.app {
					// App discovery always checks current installation access,
					// even if an OAuth-style cached list could be available.
					again, err := adapter.List(ctx, provider.ListRequest{OwnerID: owner.Hex()})
					if err != nil || !reflect.DeepEqual(again, repos) {
						t.Fatal("App discovery repeat", again, err)
					}
					saved, err := s.Store.one(ctx, "users", M{"_id": owner})
					if err != nil || len(arr(saved["repositories"])) != 0 {
						t.Fatal("App discovery persisted an OAuth cache", err)
					}
					wantOAuthCalls = 2
				}
				if c.oauth && oauthCalls != wantOAuthCalls {
					t.Fatalf("OAuth calls = %d", oauthCalls)
				}
			})
		}
	})
}
