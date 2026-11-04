package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runInstallationReconciliationIntegration(t *testing.T, base *Server) {
	t.Run("installation reconciliation metadata and revision guards", func(t *testing.T) {
		ctx := context.Background()
		db := base.Store.DB.Client().Database("installation_reconciliation_" + bson.NewObjectID().Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		s.Config.AppID = "123"
		filter := M{"appId": "123", "installationId": int64(42)}
		seed := func() {
			t.Helper()
			if _, err := db.Collection("githubinstallations").DeleteMany(ctx, M{}); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Collection("githubinstallations").InsertOne(ctx, M{"appId": "123", "installationId": int64(42), "revision": "pending", "blocked": true, "reconciliationPending": true, "accountId": int64(1), "accountLogin": "old", "accountType": "User"}); err != nil {
				t.Fatal(err)
			}
		}
		load := func() M {
			t.Helper()
			row, err := s.Store.one(ctx, "githubinstallations", filter)
			if err != nil {
				t.Fatal(err)
			}
			return row
		}
		status := 200
		current := M{}
		var duringRequest func()
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			if r.Method != "GET" || r.URL.Path != "/app/installations/42" {
				t.Fatal("unexpected reconciliation request", r.Method, r.URL)
			}
			if duringRequest != nil {
				duringRequest()
			}
			body, err := json.Marshal(current)
			if err != nil {
				t.Fatal(err)
			}
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
		})}
		for _, suspended := range []any{nil, false, "", float64(0), "2026-01-01T00:00:00Z", true} {
			seed()
			current = M{"app_id": 123, "suspended_at": suspended, "account": M{"id": 9001, "login": "renamed-org", "type": "Organization"}}
			before := time.Now().Add(-time.Second)
			if err := s.reconcileInstallation(ctx, 42, "pending", "synthetic-jwt"); err != nil {
				t.Fatal(err)
			}
			row := load()
			revision := str(row["revision"])
			if revision == "" || revision == "pending" || boolean(row["reconciliationPending"]) || boolean(row["blocked"]) != inputTruthy(suspended) {
				t.Fatal("wrong reconciliation state", row)
			}
			if number(row["accountId"]) != 9001 || row["accountLogin"] != "renamed-org" || row["accountType"] != "Organization" || date(row["checkedAt"]).Before(before) {
				t.Fatal("account metadata not refreshed", row)
			}
			// The same pending revision is consumed once, even if retried with a different response.
			current["account"] = M{"id": 2, "login": "stale", "type": "User"}
			current["suspended_at"] = "stale-suspension"
			if err := s.reconcileInstallation(ctx, 42, "pending", "synthetic-jwt"); err != nil {
				t.Fatal(err)
			}
			after := load()
			if after["revision"] != revision || after["accountLogin"] != "renamed-org" || after["blocked"] != row["blocked"] {
				t.Fatal("replayed reconciliation overwrote completed result", after)
			}
		}
		for _, failure := range []string{"upstream", "foreign-app", "missing-account"} {
			seed()
			status = 200
			current = M{"app_id": 123, "account": M{"id": 9001, "login": "renamed-org", "type": "Organization"}}
			switch failure {
			case "upstream":
				status = 503
			case "foreign-app":
				current["app_id"] = 456
			case "missing-account":
				delete(current, "account")
			}
			if err := s.reconcileInstallation(ctx, 42, "pending", "synthetic-jwt"); err == nil {
				t.Fatal("failed reconciliation accepted", failure)
			}
			row := load()
			if row["revision"] != "pending" || !boolean(row["blocked"]) || !boolean(row["reconciliationPending"]) || row["accountLogin"] != "old" {
				t.Fatal("failed reconciliation changed durable state", failure, row)
			}
		}
		seed()
		status = 200
		current = M{"app_id": 123, "account": M{"id": 9001, "login": "renamed-org", "type": "Organization"}}
		duringRequest = func() {
			if _, err := s.Store.update(ctx, "githubinstallations", filter, M{"$set": M{"revision": "newer-deletion", "blocked": true, "reconciliationPending": false}}); err != nil {
				t.Fatal(err)
			}
		}
		if err := s.reconcileInstallation(ctx, 42, "pending", "synthetic-jwt"); err != nil {
			t.Fatal(err)
		}
		row := load()
		if row["revision"] != "newer-deletion" || !boolean(row["blocked"]) || boolean(row["reconciliationPending"]) || row["accountLogin"] != "old" {
			t.Fatal("in-flight response undid newer webhook", row)
		}
	})
}
