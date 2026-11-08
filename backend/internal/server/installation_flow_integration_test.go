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
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runInstallationFlowIntegration(t *testing.T, base *Server) {
	t.Run("installation suggestions and one-time setup state", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		db := base.Store.DB.Client().Database("installation_flow_" + owner.Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		s.Config.AppEnabled = true
		s.Config.AppNewConnections = true
		s.Config.AppID = "123"
		s.Config.AppSlug = "synthetic-app"
		user := M{"_id": owner, "username": owner.Hex(), "status": "active"}
		if _, err := db.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		q := &request{Server: s, User: user, Identity: identity(user), Session: M{}, SessionID: "installation-flow-" + owner.Hex()}
		q.R = httptest.NewRequest("GET", "/", nil)
		q.W = httptest.NewRecorder()
		defer s.Store.Redis.Del(ctx, "anoGH_session:"+q.SessionID)
		for _, provider := range []string{"github", "github-app-user"} {
			if err := s.saveGrant(q, owner, provider, M{"access_token": "synthetic-" + provider, "refresh_token": "synthetic-refresh", "expires_in": float64(3600), "refresh_token_expires_in": float64(7200)}); err != nil {
				t.Fatal(err)
			}
		}
		installed, privateUnavailable := false, false
		accountType := "Organization"
		calls, repoCalls := 0, 0
		expectedToken := "synthetic-github"
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			calls++
			status := 200
			data := M{}
			switch r.URL.Path {
			case "/user/installations":
				items := []M{}
				if installed {
					items = append(items, M{"id": 42, "app_id": 123, "account": M{"id": 90, "login": "team", "type": accountType}, "suspended_at": nil})
				}
				data["installations"] = items
			case "/repos/team/private":
				repoCalls++
				if !strings.HasSuffix(r.Header.Get("Authorization"), expectedToken) {
					t.Fatal("wrong repository suggestion credential")
				}
				if privateUnavailable {
					status = 404
				}
				data = M{"id": 17, "owner": M{"id": 90}}
			default:
				t.Fatal("unexpected installation flow request", r.URL)
			}
			body, err := json.Marshal(data)
			if err != nil {
				t.Fatal(err)
			}
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
		})}
		run := func(path string) (*httptest.ResponseRecorder, error) {
			t.Helper()
			q.R = httptest.NewRequest("GET", path, nil)
			w := httptest.NewRecorder()
			q.W = w
			_, err := s.appInstall(q)
			return w, err
		}
		for _, tc := range []struct {
			name, query, path      string
			installed, unavailable bool
			account                string
			errorCode              string
		}{
			{name: "new-private", query: "repository=team/private", path: "/apps/synthetic-app/installations/new/permissions"},
			{name: "existing-org", query: "repository=team/private", path: "/organizations/team/settings/installations/42", installed: true, account: "Organization"},
			{name: "existing-user", query: "repository=team/private", path: "/settings/installations/42", installed: true, account: "User"},
			{name: "explicit", query: "installationId=42", path: "/organizations/team/settings/installations/42", installed: true, account: "Organization"},
			{name: "empty-id", query: "installationId=", errorCode: "github_app_access_required"},
			{name: "repeated-id", query: "installationId=42&installationId=43", path: "/apps/synthetic-app/installations/new", installed: true},
			{name: "mixed-id", query: "installationId=42&installationId[]=43", path: "/apps/synthetic-app/installations/new", installed: true},
			{name: "mixed-repository", query: "repository=team/private&repository[]=team/other", path: "/apps/synthetic-app/installations/new"},
			{name: "invisible", query: "repository=team/private", path: "/apps/synthetic-app/installations/new", unavailable: true},
			{name: "invalid-name", query: "repository=team/private/extra", path: "/apps/synthetic-app/installations/new"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				installed, privateUnavailable = tc.installed, tc.unavailable
				accountType = tc.account
				before := repoCalls
				w, err := run("/github/app/install?" + tc.query + "&returnTo=/dashboard")
				if tc.errorCode != "" {
					if err == nil || err.Error() != tc.errorCode {
						t.Fatal(err)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				target, err := url.Parse(w.Header().Get("Location"))
				if err != nil {
					t.Fatal(err)
				}
				if target.Host != "github.com" || target.Path != tc.path || target.Query().Get("state") == "" {
					t.Fatal("wrong install target", target)
				}
				flow := obj(q.Session["githubInstallFlow"])
				if flow["state"] != target.Query().Get("state") || flow["ownerId"] != owner.Hex() || flow["returnTo"] != "/dashboard" {
					t.Fatal("flow not bound to owner/redirect")
				}
				if tc.name == "new-private" && (target.Query().Get("suggested_target_id") != "90" || target.Query().Get("repository_ids[]") != "17") {
					t.Fatal("private repository not suggested", target)
				}
				if (tc.name == "invalid-name" || tc.name == "explicit" || tc.name == "repeated-id") && repoCalls != before {
					t.Fatal("unexpected repository lookup")
				}
			})
		}
		if _, err := db.Collection("credentials").DeleteOne(ctx, M{"ownerId": owner, "provider": "github"}); err != nil {
			t.Fatal(err)
		}
		installed = false
		privateUnavailable = false
		expectedToken = "synthetic-github-app-user"
		if _, err := run("/github/app/install?repository=team/private"); err != nil {
			t.Fatal("App fallback failed", err)
		}
		installed = true
		accountType = "Organization"
		for _, tc := range []struct {
			name, query, code   string
			expired, otherOwner bool
			clear               bool
		}{
			{name: "success", query: "state=state&installation_id=42", clear: true},
			{name: "request", query: "state=state&setup_action=request", clear: true},
			{name: "no-state", query: "installation_id=999"},
			{name: "duplicate-state", query: "state=state&state=state&installation_id=42", code: "invalid_auth_state"},
			{name: "mixed-state", query: "state=state&state[]=state&installation_id=42", code: "invalid_auth_state"},
			{name: "array-state", query: "state[]=", code: "invalid_auth_state"},
			{name: "mixed-id", query: "state=state&installation_id=42&installation_id[]=42", code: "github_app_access_required"},
			{name: "mixed-action", query: "state=state&setup_action=request&setup_action[]=request", code: "github_app_access_required"},
			{name: "wrong-owner", query: "state=state&installation_id=42", code: "invalid_auth_state", otherOwner: true},
			{name: "expired", query: "state=state&installation_id=42", code: "invalid_auth_state", expired: true},
			{name: "duplicate-id", query: "state=state&installation_id=42&installation_id=42", code: "github_app_access_required"},
			{name: "duplicate-action", query: "state=state&setup_action=request&setup_action=request", code: "github_app_access_required"},
		} {
			t.Run("setup-"+tc.name, func(t *testing.T) {
				flow := M{"state": "state", "ownerId": owner.Hex(), "expires": time.Now().Add(time.Minute).UnixMilli(), "returnTo": "/dashboard"}
				if tc.expired {
					flow["expires"] = time.Now().Add(-time.Minute).UnixMilli()
				}
				if tc.otherOwner {
					flow["ownerId"] = bson.NewObjectID().Hex()
				}
				q.Session["githubInstallFlow"] = flow
				if _, err := s.Store.update(ctx, "users", M{"_id": owner}, M{"$set": M{"repositories": []any{"cached"}}}); err != nil {
					t.Fatal(err)
				}
				before := calls
				w, err := run("/github/app/setup?" + tc.query)
				if tc.code == "" && err != nil || tc.code != "" && (err == nil || err.Error() != tc.code) {
					t.Fatal("wrong setup result", err)
				}
				if q.Session["githubInstallFlow"] != nil {
					t.Fatal("setup state not consumed")
				}
				persisted, err := s.Store.Redis.Get(ctx, "anoGH_session:"+q.SessionID).Result()
				if err != nil || strings.Contains(persisted, "githubInstallFlow") {
					t.Fatal("consumed state remained in session", err)
				}
				saved, err := s.Store.one(ctx, "users", M{"_id": owner})
				if err != nil {
					t.Fatal(err)
				}
				if (len(arr(saved["repositories"])) == 0) != tc.clear {
					t.Fatal("incorrect discovery cache invalidation")
				}
				if tc.name == "no-state" && (calls != before || w.Header().Get("Location") != "/dashboard") {
					t.Fatal("stateless callback attached installation")
				}
				if tc.clear {
					if _, err := run("/github/app/setup?" + tc.query); err == nil || err.Error() != "invalid_auth_state" {
						t.Fatal("replayed setup accepted", err)
					}
				}
			})
		}
	})
}
