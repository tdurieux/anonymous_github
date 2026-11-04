package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runGrantReconciliationIntegration(t *testing.T, base *Server) {
	t.Run("grant reconciliation preserves concurrent identity changes", func(t *testing.T) {
		ctx := context.Background()
		db := base.Store.DB.Client().Database("grant_reconciliation_" + bson.NewObjectID().Hex())
		defer db.Drop(ctx)
		for _, scenario := range []string{"working", "revoked", "upstream-failure", "refresh", "refresh-failure", "new-login", "concurrent-revocation", "same-revision-revocation"} {
			t.Run(scenario, func(t *testing.T) {
				s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
				s.Config.AppEnabled = true
				owner := bson.NewObjectID()
				if _, err := db.Collection("users").InsertOne(ctx, M{"_id": owner, "username": owner.Hex(), "status": "active"}); err != nil {
					t.Fatal(err)
				}
				q := &request{Server: s, R: httptest.NewRequest("GET", "/", nil)}
				tokens := func(access string) M {
					return M{"access_token": access, "refresh_token": "synthetic-refresh", "expires_in": float64(3600), "refresh_token_expires_in": float64(7200)}
				}
				save := func(access string) {
					t.Helper()
					if err := s.saveGrant(q, owner, "github-app-user", tokens(access)); err != nil {
						t.Fatal(err)
					}
				}
				save("synthetic-original")
				filter := M{"ownerId": owner, "provider": "github-app-user"}
				update := func(fields M) {
					t.Helper()
					if _, err := s.Store.update(ctx, "credentials", filter, M{"$set": fields}); err != nil {
						t.Fatal(err)
					}
				}
				load := func() M {
					t.Helper()
					row, err := s.Store.one(ctx, "credentials", filter)
					if err != nil {
						t.Fatal(err)
					}
					return row
				}
				update(M{"reconciliationPending": true})
				if scenario == "refresh" || scenario == "refresh-failure" {
					update(M{"expiresAt": time.Now().Add(-time.Hour)})
				}
				original := load()
				requests, refreshes := 0, 0
				newerRevision := ""
				s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
					status := 200
					response := M{"id": 789}
					switch r.URL.Path {
					case "/login/oauth/access_token":
						refreshes++
						response = tokens("synthetic-refreshed")
						if scenario == "refresh-failure" {
							status = 503
							response = M{"error": "temporary"}
						}
					case "/user":
						requests++
						expected := "synthetic-original"
						if scenario == "refresh" {
							expected = "synthetic-refreshed"
						}
						if !strings.HasSuffix(r.Header.Get("Authorization"), expected) {
							t.Fatal("checked wrong token")
						}
						switch scenario {
						case "revoked":
							status = 401
						case "upstream-failure":
							status = 503
						case "new-login":
							save("synthetic-new-login")
							update(M{"reconciliationPending": true})
							newerRevision = str(load()["revision"])
						case "concurrent-revocation":
							update(M{"revoked": true, "revision": "newer-revocation", "reconciliationPending": false})
						case "same-revision-revocation":
							update(M{"revoked": true, "reconciliationPending": false})
						}
					default:
						t.Fatal("unexpected grant endpoint", r.URL)
					}
					body, err := json.Marshal(response)
					if err != nil {
						t.Fatal(err)
					}
					return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
				})}
				err := s.reconcileGrant(ctx, original)
				failure := scenario == "upstream-failure" || scenario == "refresh-failure"
				if (err != nil) != failure {
					t.Fatal("unexpected reconciliation result", err)
				}
				row := load()
				switch scenario {
				case "working":
					if boolean(row["reconciliationPending"]) || boolean(row["revoked"]) || row["revision"] != original["revision"] {
						t.Fatal("working grant changed", row)
					}
				case "revoked":
					if !boolean(row["revoked"]) || boolean(row["reconciliationPending"]) || row["revision"] == original["revision"] {
						t.Fatal("revocation did not consume revision", row)
					}
				case "upstream-failure", "refresh-failure":
					if boolean(row["revoked"]) || !boolean(row["reconciliationPending"]) || row["revision"] != original["revision"] {
						t.Fatal("failure changed grant state", row)
					}
				case "refresh":
					if boolean(row["reconciliationPending"]) || boolean(row["revoked"]) || row["revision"] == original["revision"] {
						t.Fatal("refreshed grant left pending", row)
					}
					if token, err := s.credential(ctx, owner, "github-app-user"); err != nil || token != "synthetic-refreshed" {
						t.Fatal("refreshed grant unavailable", err)
					}
				case "new-login":
					if !boolean(row["reconciliationPending"]) || boolean(row["revoked"]) || row["revision"] != newerRevision {
						t.Fatal("old check changed newer login", row)
					}
				case "concurrent-revocation", "same-revision-revocation":
					if !boolean(row["revoked"]) || boolean(row["reconciliationPending"]) {
						t.Fatal("old check restored revoked grant", row)
					}
				}
				expectedRequests, expectedRefreshes := 1, 0
				if scenario == "refresh" || scenario == "refresh-failure" {
					expectedRefreshes = 1
				}
				if scenario == "refresh-failure" {
					expectedRequests = 0
				}
				if requests != expectedRequests || refreshes != expectedRefreshes {
					t.Fatal("unexpected upstream calls", requests, refreshes)
				}
			})
		}
	})
}
