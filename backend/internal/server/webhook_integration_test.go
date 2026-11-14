package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runWebhookIntegration(t *testing.T, base *Server) {
	t.Run("signed webhook admission and complete grant reconciliation", func(t *testing.T) {
		ctx := context.Background()
		db := base.Store.DB.Client().Database("webhooks_" + bson.NewObjectID().Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		s.Config.AppEnabled = true
		s.Config.AppID = "123"
		s.Config.AppWebhookSecret = "synthetic-webhook-secret"
		calls := 0
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			if r.Method != "GET" || r.URL.Path != "/user" {
				t.Fatal("unexpected upstream request", r.Method, r.URL)
			}
			calls++
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"id":789}`))}, nil
		})}
		send := func(event string, payload M, tampered bool) *httptest.ResponseRecorder {
			t.Helper()
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			mac := hmac.New(sha256.New, []byte(s.Config.AppWebhookSecret))
			mac.Write(body)
			signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))
			if tampered {
				body = append(body, ' ')
			}
			r := httptest.NewRequest("POST", "/github/app/webhook", bytes.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-Hub-Signature-256", signature)
			r.Header.Set("X-GitHub-Event", event)
			w := httptest.NewRecorder()
			s.webhook(w, r)
			return w
		}
		for _, event := range []string{"installation", "installation_repositories"} {
			for i, id := range []any{nil, "42", true, 1.5, 9007199254740992.0, -9007199254740992.0, 0, -1, 42, 9007199254740991.0} {
				payload := M{"action": "deleted", "installation": M{"id": id, "app_id": 123}}
				w := send(event, payload, false)
				if w.Code != 204 {
					t.Fatal(event, id, w.Code, w.Body.String())
				}
				count, err := db.Collection("githubinstallations").CountDocuments(ctx, M{})
				if err != nil {
					t.Fatal(err)
				}
				expected := int64(0)
				if i >= 6 {
					expected = 1
				}
				if count != expected {
					t.Fatal("unsafe installation ID accepted or safe ID skipped", id, count)
				}
				if expected == 1 {
					row, err := s.Store.one(ctx, "githubinstallations", M{})
					if err != nil || !boolean(row["blocked"]) || boolean(row["reconciliationPending"]) || str(row["revision"]) == "" {
						t.Fatal("deletion did not durably block installation", row, err)
					}
				}
				if _, err := db.Collection("githubinstallations").DeleteMany(ctx, M{}); err != nil {
					t.Fatal(err)
				}
			}
		}
		// A forged payload and an installation belonging to another App cannot mutate state.
		for _, tampered := range []bool{false, true} {
			w := send("installation", M{"action": "deleted", "installation": M{"id": 42, "app_id": 456}}, tampered)
			expected := 204
			if tampered {
				expected = 401
			}
			if w.Code != expected {
				t.Fatal("signature/App isolation", w.Code)
			}
			count, err := db.Collection("githubinstallations").CountDocuments(ctx, M{})
			if err != nil || count != 0 {
				t.Fatal("foreign installation persisted", count, err)
			}
		}
		// GitHub permits payloads above the former Go-only 1 MiB boundary.
		if w := send("ping", M{"padding": strings.Repeat("x", 1536*1024)}, false); w.Code != 204 {
			t.Fatal("valid large payload rejected", w.Code)
		}
		if w := send("ping", M{"padding": strings.Repeat("x", 2*1024*1024)}, false); w.Code < 400 {
			t.Fatal("oversized payload accepted")
		}
		// Missing/falsy sender IDs must not reconcile users with empty provider IDs.
		owner := bson.NewObjectID()
		if _, err := db.Collection("users").InsertOne(ctx, M{"_id": owner, "status": "active", "externalIDs": M{"github": ""}}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Collection("credentials").InsertOne(ctx, M{"ownerId": owner, "provider": "github-app-user", "revision": "invalid-envelope"}); err != nil {
			t.Fatal(err)
		}
		for _, id := range []any{nil, false, 0, ""} {
			if w := send("github_app_authorization", M{"action": "revoked", "sender": M{"id": id}}, false); w.Code != 204 {
				t.Fatal("falsy sender processed", id, w.Code)
			}
		}
		for i := 0; i < 101; i++ {
			owner := bson.NewObjectID()
			if _, err := db.Collection("users").InsertOne(ctx, M{"_id": owner, "username": owner.Hex(), "status": "active", "externalIDs": M{"github": "789"}}); err != nil {
				t.Fatal(err)
			}
			q := &request{Server: s, R: httptest.NewRequest("GET", "/", nil)}
			if err := s.saveGrant(q, owner, "github-app-user", M{"access_token": "synthetic-token", "refresh_token": "synthetic-refresh", "expires_in": float64(3600), "refresh_token_expires_in": float64(7200)}); err != nil {
				t.Fatal(err)
			}
		}
		for replay := 0; replay < 2; replay++ {
			if w := send("github_app_authorization", M{"action": "revoked", "sender": M{"id": 789}}, false); w.Code != 204 {
				t.Fatal("grant reconciliation failed", w.Code, w.Body.String())
			}
			if calls != 101*(replay+1) {
				t.Fatal("grant reconciliation truncated", calls)
			}
			count, err := db.Collection("credentials").CountDocuments(ctx, M{"revoked": false, "reconciliationPending": false})
			if err != nil || count != 101 {
				t.Fatal("working grants invalidated by replay", count, err)
			}
		}
	})
}
