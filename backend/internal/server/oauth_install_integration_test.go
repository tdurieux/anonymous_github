package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runOAuthInstallIntegration(t *testing.T, base *Server) {
	t.Run("App login preserves installation intent", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		db := base.Store.DB.Client().Database("oauth_install_" + owner.Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		s.Config.AppEnabled = true
		s.Config.AppNewConnections = true
		user := M{"_id": owner, "username": owner.Hex(), "status": "active", "externalIDs": M{"github": "98765001"}}
		if _, err := db.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		calls := 0
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			if r.URL.Path == "/user/emails" {
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("[]"))}, nil
			}
			calls++
			data := M{}
			switch r.URL.Path {
			case "/login/oauth/access_token":
				data = M{"access_token": "synthetic-token", "refresh_token": "synthetic-refresh", "expires_in": 3600, "refresh_token_expires_in": 7200}
			case "/user":
				data = M{"id": 98765001, "login": owner.Hex()}
			default:
				t.Fatal("unexpected OAuth request", r.URL)
			}
			body, err := json.Marshal(data)
			if err != nil {
				t.Fatal(err)
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
		})}
		for _, tc := range []struct {
			name, query, returnTo, repository, callbackExtra, errorCode string
			authenticated, install, disable                             bool
		}{
			{name: "anonymous-default", returnTo: "/dashboard"},
			{name: "authenticated-default", authenticated: true, returnTo: "/connections"},
			{name: "install", query: "install=1&repository=team/private&returnTo=%2Fdashboard%3Ftab%3Downed", returnTo: "/dashboard?tab=owned", repository: "team/private", install: true, callbackExtra: "&install=0&repository=other/project&returnTo=/wrong"},
			{name: "repeated-install", query: "install=1&install=1", returnTo: "/dashboard"},
			{name: "repeated-repository", query: "install=1&repository=team/a&repository=team/b", returnTo: "/dashboard", install: true},
			{name: "unsafe-return", query: "returnTo=https://outside.test", returnTo: "/connections"},
			{name: "repeated-return", query: "returnTo=/one&returnTo=/two", returnTo: "/connections"},
			{name: "repeated-state", returnTo: "/dashboard", callbackExtra: "&state=duplicate", errorCode: "invalid_auth_state"},
			{name: "repeated-code", returnTo: "/dashboard", callbackExtra: "&code=duplicate", errorCode: "github_app_authorization_cancelled"},
			{name: "repeated-error", returnTo: "/dashboard", callbackExtra: "&error=&error=", errorCode: "github_app_authorization_cancelled"},
			{name: "mixed-state", returnTo: "/dashboard", callbackExtra: "&state[]=duplicate", errorCode: "invalid_auth_state"},
			{name: "mixed-code", returnTo: "/dashboard", callbackExtra: "&code[]=duplicate", errorCode: "github_app_authorization_cancelled"},
			{name: "object-error", returnTo: "/dashboard", callbackExtra: "&error[x]=", errorCode: "github_app_authorization_cancelled"},
			{name: "empty-array-error", returnTo: "/dashboard", callbackExtra: "&error[]=", errorCode: "github_app_authorization_cancelled"},
			{name: "mixed-install", query: "install=1&install[]=1", returnTo: "/dashboard"},
			{name: "mixed-repository", query: "install=1&repository=team/a&repository[]=team/b", returnTo: "/dashboard", install: true},
			{name: "mixed-return", query: "returnTo=/one&returnTo[]=", returnTo: "/connections"},
			{name: "empty-array-return", query: "returnTo[]=", returnTo: "/connections"},
			{name: "connections-disabled", returnTo: "/dashboard", disable: true, errorCode: "github_app_disabled"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				s.Config.AppNewConnections = true
				q := &request{Server: s, Session: M{}, R: httptest.NewRequest("GET", "/github/app/login?"+tc.query, nil), W: httptest.NewRecorder()}
				if tc.authenticated {
					q.User = user
					q.Identity = identity(user)
				}
				defer func() { s.Store.Redis.Del(ctx, "anoGH_session:"+q.SessionID) }()
				if _, err := s.oauthStart(q); err != nil {
					t.Fatal(err)
				}
				start := q.W.(*httptest.ResponseRecorder)
				target, err := url.Parse(start.Header().Get("Location"))
				if err != nil {
					t.Fatal(err)
				}
				state := target.Query().Get("state")
				stored, err := s.Store.Redis.Get(ctx, "go:oauth:"+state).Bytes()
				if err != nil {
					t.Fatal(err)
				}
				var flow authFlow
				if err = json.Unmarshal(stored, &flow); err != nil {
					t.Fatal(err)
				}
				if flow.ReturnTo != tc.returnTo || flow.Repository != tc.repository || flow.Install != tc.install || flow.SessionID != q.SessionID {
					t.Fatal("login intent not stored correctly", flow)
				}
				before := calls
				q.R = httptest.NewRequest("GET", "/github/app/callback?state="+state+"&code=synthetic-code"+tc.callbackExtra, nil)
				callback := httptest.NewRecorder()
				q.W = callback
				if tc.disable {
					s.Config.AppNewConnections = false
				}
				_, err = s.oauthCallback(q)
				if tc.errorCode != "" {
					if err == nil || err.Error() != tc.errorCode || calls != before {
						t.Fatal("invalid callback reached upstream or wrong error", err, calls-before)
					}
				} else {
					if err != nil {
						t.Fatal(err)
					}
					location, err := url.Parse(callback.Header().Get("Location"))
					if err != nil {
						t.Fatal(err)
					}
					if tc.install {
						if location.Path != "/github/app/install" || location.Query().Get("returnTo") != tc.returnTo || location.Query().Get("repository") != tc.repository {
							t.Fatal("installation intent lost or callback overrode it", location)
						}
					} else if location.String() != tc.returnTo {
						t.Fatal("wrong post-login destination", location)
					}
					if calls != before+2 {
						t.Fatal("unexpected upstream requests", calls-before)
					}
				}
				if tc.disable {
					if n := s.Store.Redis.Exists(ctx, "go:oauth:"+state, oauthPendingKey(q.SessionID, true)).Val(); n != 2 {
						t.Fatal("disabled callback consumed flow", n)
					}
					s.Config.AppNewConnections = true
					q.R = httptest.NewRequest("GET", "/github/app/callback?state="+state+"&error=cancelled", nil)
					if _, err := s.oauthCallback(q); err == nil || err.Error() != "github_app_authorization_cancelled" || calls != before {
						t.Fatal("preserved flow unusable after re-enable", err)
					}
				}
				if n, err := s.Store.Redis.Exists(ctx, "go:oauth:"+state).Result(); err != nil || n != 0 {
					t.Fatal("OAuth state survived callback", n, err)
				}
			})
		}
	})
}
