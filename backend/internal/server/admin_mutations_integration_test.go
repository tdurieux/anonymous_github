package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAdminMutationsIntegration(t *testing.T, s *Server) {
	t.Run("admin mutations persist and ban continues after enqueue failure", func(t *testing.T) {
		ctx := context.Background()
		adminToken, targetToken := "synthetic-mutation-admin", "synthetic-mutation-target"
		admin, target := bson.NewObjectID(), bson.NewObjectID()
		for _, u := range []M{{"_id": admin, "username": "mutation-admin", "status": "active", "isAdmin": true, "apiTokens": []M{{"tokenHash": security.HashToken(adminToken)}}}, {"_id": target, "username": "mutation-target", "status": "active", "apiTokens": []M{{"tokenHash": security.HashToken(targetToken)}}}} {
			if _, err := s.Store.DB.Collection("users").InsertOne(ctx, u); err != nil {
				t.Fatal(err)
			}
		}
		call := func(method, path, token string) *httptest.ResponseRecorder {
			req := httptest.NewRequest(method, path, nil)
			req.RemoteAddr = "198.51.100.18:1234"
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		mutate := func(username, action, token string) *httptest.ResponseRecorder {
			return call("POST", "/api/admin/users/"+username+"/"+action, token)
		}
		for _, action := range []string{"ban", "activate", "promote", "demote"} {
			if w := mutate("mutation-target", action, targetToken); w.Code != 401 {
				t.Fatal("non-admin mutation", action, w.Code, w.Body)
			}
			if w := mutate("mutation-missing", action, adminToken); w.Code != 404 {
				t.Fatal("missing user", action, w.Code, w.Body)
			}
		}
		for _, action := range []string{"promote", "demote"} {
			w := mutate("mutation-target", action, adminToken)
			var out M
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || !reflect.DeepEqual(out, M{"ok": true}) {
				t.Fatal(action, w.Code, w.Body)
			}
			stored, err := s.Store.one(ctx, "users", M{"_id": target})
			if err != nil {
				t.Fatal(err)
			}
			if boolean(stored["isAdmin"]) != (action == "promote") {
				t.Fatal("role not saved", stored)
			}
			wanted := 200
			if action == "demote" {
				wanted = 401
			}
			if w := call("GET", "/api/admin/users?search=mutation-target", targetToken); w.Code != wanted {
				t.Fatal("role not effective", action, w.Code, w.Body)
			}
		}
		before := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
		for _, state := range []string{"ready", "queue-failure", "archived", "error", "removed", "removing"} {
			status := state
			if state == "queue-failure" {
				status = "ready"
			}
			if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, M{"_id": bson.NewObjectID(), "repoId": "ban-mutation-" + state, "owner": target, "status": status, "statusDate": before}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, M{"_id": bson.NewObjectID(), "repoId": "ban-mutation-coauthor-only", "owner": admin, "coauthors": []M{{"username": "mutation-target"}}, "status": "ready", "statusDate": before}); err != nil {
			t.Fatal(err)
		}
		validator := func(value M) error {
			return s.Store.DB.RunCommand(ctx, bson.D{{Key: "collMod", Value: "gojobs"}, {Key: "validator", Value: value}, {Key: "validationLevel", Value: "strict"}, {Key: "validationAction", Value: "error"}}).Err()
		}
		if err := validator(M{"resourceId": M{"$ne": "ban-mutation-queue-failure"}}); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := validator(M{}); err != nil {
				t.Error(err)
			}
		}()
		w := mutate("mutation-target", "ban", adminToken)
		var out M
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || out["ok"] != true || number(out["reposQueued"]) != 3 {
			t.Fatal("ban stopped at failed enqueue", w.Code, w.Body)
		}
		user, err := s.Store.one(ctx, "users", M{"_id": target})
		if err != nil || user["status"] != "banned" {
			t.Fatal(user, err)
		}
		if w := call("GET", "/api/user", targetToken); w.Code != 401 {
			t.Fatal("banned credential accepted", w.Code, w.Body)
		}
		for _, state := range []string{"ready", "queue-failure", "archived", "error", "removed", "removing", "coauthor-only"} {
			id := "ban-mutation-" + state
			row, err := s.Store.one(ctx, collection("repo"), M{"repoId": id})
			if err != nil {
				t.Fatal(err)
			}
			want := "removing"
			if state == "removed" {
				want = "removed"
			}
			if state == "coauthor-only" {
				want = "ready"
			}
			if row["status"] != want {
				t.Fatal(id, row["status"], want)
			}
			if state == "removed" || state == "removing" || state == "coauthor-only" {
				if !date(row["statusDate"]).Equal(before) {
					t.Fatal("excluded repository changed", id)
				}
			}
		}
		if err := validator(M{}); err != nil {
			t.Fatal(err)
		}
		if err := s.enqueue(ctx, "repo", "ban-mutation-queue-failure", "remove"); err != nil {
			t.Fatal(err)
		}
		if err := s.runJob(ctx, M{"kind": "repo", "resourceId": "ban-mutation-queue-failure", "action": "remove"}); err != nil {
			t.Fatal(err)
		}
		if w := mutate("mutation-target", "activate", adminToken); w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		if w := call("GET", "/api/user", targetToken); w.Code != 200 {
			t.Fatal("activation not effective", w.Code, w.Body)
		}
		// Admin activation changes status only; anonymized account data stays erased.
		deleted := M{"_id": bson.NewObjectID(), "username": "deleted-mutation-fixture", "status": "removed", "apiTokens": []any{}, "emails": []any{}}
		if _, err := s.Store.DB.Collection("users").InsertOne(ctx, deleted); err != nil {
			t.Fatal(err)
		}
		if w := mutate(str(deleted["username"]), "activate", adminToken); w.Code != 200 {
			t.Fatal("removed activation", w.Code, w.Body)
		}
		restored, err := s.Store.one(ctx, "users", M{"_id": deleted["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		if restored["status"] != "active" || restored["externalIDs"] != nil || len(arr(restored["apiTokens"])) != 0 || len(arr(restored["emails"])) != 0 {
			t.Fatal("activation recreated erased identity", restored)
		}
	})
}
