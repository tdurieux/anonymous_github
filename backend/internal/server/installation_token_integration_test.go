package server

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runInstallationTokenIntegration(t *testing.T, base *Server) {
	t.Run("installation token expiry caching and access reconciliation", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		db := base.Store.DB.Client().Database("installation_token_" + owner.Hex())
		defer db.Drop(ctx)
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		config := base.Config
		config.AppEnabled = true
		config.AppID = "123"
		config.AppClientID = "synthetic-client"
		config.AppPrivateKey = string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
		s := &Server{Config: config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		if _, err := db.Collection("users").InsertOne(ctx, M{"_id": owner, "username": owner.Hex(), "status": "active"}); err != nil {
			t.Fatal(err)
		}
		q := &request{Server: s, R: httptest.NewRequest("GET", "/", nil)}
		if err := s.saveGrant(q, owner, "github-app-user", M{"access_token": "synthetic-app", "refresh_token": "synthetic-refresh", "expires_in": float64(3600), "refresh_token_expires_in": float64(7200)}); err != nil {
			t.Fatal(err)
		}
		binding := M{"kind": "github-app", "repositoryId": int64(10), "installationId": int64(42)}
		filter := M{"appId": "123", "installationId": int64(42)}
		seed := func(pending bool) {
			t.Helper()
			s.appTokens = nil
			if _, err := db.Collection("githubinstallations").DeleteMany(ctx, M{}); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Collection("githubinstallations").InsertOne(ctx, M{"appId": "123", "installationId": int64(42), "revision": "original", "blocked": pending, "reconciliationPending": pending}); err != nil {
				t.Fatal(err)
			}
		}
		issued := M{}
		checks, mints, installationReads := 0, 0, 0
		failReconcile, denyUser := false, false
		suspended := any(false)
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			status := 200
			response := M{}
			switch r.URL.Path {
			case "/repositories/10":
				checks++
				response = M{"id": 10}
				if denyUser {
					status = 403
				}
			case "/app/installations/42":
				installationReads++
				if failReconcile {
					status = 503
				}
				response = M{"id": 42, "app_id": 123, "suspended_at": suspended, "account": M{"id": 90, "login": "team", "type": "Organization"}, "permissions": M{"contents": "read", "pull_requests": "read", "pages": "read"}}
			case "/app/installations/42/access_tokens":
				mints++
				response = issued
				var body M
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if len(arr(body["repository_ids"])) != 1 || number(arr(body["repository_ids"])[0]) != 10 || len(obj(body["permissions"])) != 4 {
					t.Fatal("token scope differs", body)
				}
			default:
				t.Fatal("unexpected installation token endpoint", r.URL)
			}
			data, err := json.Marshal(response)
			if err != nil {
				t.Fatal(err)
			}
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
		})}
		t.Run("permission freshness and local revocation", func(t *testing.T) {
			seed(false)
			s.Config.GitHubPermissionTTL = time.Hour
			defer func() { s.Config.GitHubPermissionTTL = 0; s.permissions.entries = nil }()
			issued = M{"token": "synthetic-installation", "expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)}
			before := checks
			for range 3 {
				if _, err := s.boundToken(ctx, owner, binding, "team/project"); err != nil {
					t.Fatal(err)
				}
			}
			if checks != before+1 {
				t.Fatal("warm reads rechecked GitHub", checks-before)
			}
			update := func(collection string, filter, fields M) {
				t.Helper()
				if _, err := s.Store.update(ctx, collection, filter, M{"$set": fields}); err != nil {
					t.Fatal(err)
				}
			}
			reject := func() {
				t.Helper()
				if _, err := s.boundToken(ctx, owner, binding, "team/project"); err == nil {
					t.Fatal("local revocation bypassed")
				}
			}
			update("users", M{"_id": owner}, M{"status": "banned"})
			reject()
			update("users", M{"_id": owner}, M{"status": "active"})
			update("credentials", M{"ownerId": owner, "provider": "github-app-user"}, M{"revoked": true})
			reject()
			update("credentials", M{"ownerId": owner, "provider": "github-app-user"}, M{"revoked": false})
			update("githubinstallations", filter, M{"blocked": true})
			reject()
			update("githubinstallations", filter, M{"blocked": false, "revision": "webhook-change"})
			denyUser = true
			reject()
			reject()
			if checks != before+3 {
				t.Fatal("webhook revision or failed check cached", checks-before)
			}
			denyUser = false
			if _, err := s.boundToken(ctx, owner, binding, "team/project"); err != nil {
				t.Fatal(err)
			}
			for key := range s.permissions.entries {
				s.permissions.entries[key] = time.Now().Add(-time.Second)
			}
			denyUser = true
			reject()
			denyUser = false
		})

		for _, bad := range []M{{"token": "synthetic"}, {"token": "synthetic", "expires_at": "invalid"}, {"token": "synthetic", "expires_at": nil}, {"token": "", "expires_at": "2030-01-01T00:00:00Z"}, {"token": 42, "expires_at": "2030-01-01T00:00:00Z"}} {
			seed(false)
			issued = bad
			if _, err := s.boundToken(ctx, owner, binding, "team/project"); err == nil || err.Error() != "github_app_reconnect_required" || len(s.appTokens) != 0 {
				t.Fatal("invalid issuance accepted or cached", bad, err)
			}
		}
		seed(true)
		issued = M{"token": "synthetic-installation", "expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)}
		beforeMints, beforeReads := mints, installationReads
		if token, err := s.boundToken(ctx, owner, binding, "team/project"); err != nil || token != "synthetic-installation" {
			t.Fatal("pending installation did not recover on access", err)
		}
		local, err := s.Store.one(ctx, "githubinstallations", filter)
		if err != nil {
			t.Fatal(err)
		}
		if boolean(local["blocked"]) || boolean(local["reconciliationPending"]) || local["revision"] == "original" || local["accountLogin"] != "team" || mints != beforeMints+1 || installationReads != beforeReads+2 {
			t.Fatal("incomplete access reconciliation", local)
		}
		beforeChecks := checks
		if _, err := s.boundToken(ctx, owner, binding, "team/project"); err != nil || checks != beforeChecks+1 || mints != beforeMints+1 {
			t.Fatal("cache skipped authorization or minted twice", err)
		}
		denyUser = true
		if _, err := s.boundToken(ctx, owner, binding, "team/project"); err == nil || mints != beforeMints+1 {
			t.Fatal("cached token bypassed revoked user rights", err)
		}
		denyUser = false
		if _, err := s.Store.update(ctx, "githubinstallations", filter, M{"$set": M{"blocked": true, "revision": "blocked"}}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.boundToken(ctx, owner, binding, "team/project"); err == nil {
			t.Fatal("cached token bypassed installation block")
		}
		seed(true)
		failReconcile = true
		beforeMints = mints
		if _, err := s.boundToken(ctx, owner, binding, "team/project"); err == nil || mints != beforeMints {
			t.Fatal("failed reconciliation minted a token", err)
		}
		local, err = s.Store.one(ctx, "githubinstallations", filter)
		if err != nil || !boolean(local["blocked"]) || !boolean(local["reconciliationPending"]) || local["revision"] != "original" {
			t.Fatal("failed reconciliation lost retry state", local, err)
		}
		failReconcile = false
		seed(false)
		s.appTokens = map[string]installationToken{}
		for i := 0; i < 1000; i++ {
			s.appTokens[fmt.Sprint(i)] = installationToken{"old", time.Now().Add(time.Hour)}
		}
		if _, err := s.boundToken(ctx, owner, binding, "team/project"); err != nil || len(s.appTokens) != 1 {
			t.Fatal("token cache did not reset at capacity", len(s.appTokens), err)
		}
		for _, expiry := range []time.Time{time.Now().Add(30 * time.Second), time.Now().Add(-time.Hour)} {
			seed(false)
			issued = M{"token": "near-expiry", "expires_at": expiry.Format(time.RFC3339)}
			beforeMints = mints
			for attempt := 0; attempt < 2; attempt++ {
				if _, err := s.boundToken(ctx, owner, binding, "team/project"); err != nil {
					t.Fatal("finite expiry rejected", err)
				}
			}
			if mints != beforeMints+2 {
				t.Fatal("near-expiry token reused")
			}
		}
	})
}
