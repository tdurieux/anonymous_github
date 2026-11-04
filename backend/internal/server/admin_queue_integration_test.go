package server

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAdminQueueIntegration(t *testing.T, base *Server) {
	t.Run("queue controls preserve job identities and group expiry", func(t *testing.T) {
		ctx := context.Background()
		db := base.Store.DB.Client().Database("admin_queue_" + bson.NewObjectID().Hex())
		defer db.Drop(ctx)
		s := &Server{Store: &Store{DB: db, Redis: base.Store.Redis}}
		if err := s.Store.ensureIndexes(ctx); err != nil {
			t.Fatal(err)
		}
		call := func(method, queue, operation string) (any, error) {
			return s.adminQueues(&request{Server: s, R: httptest.NewRequest(method, "/?queue="+queue, nil), Params: map[string]string{"name": queue, "operation": operation}})
		}
		expectError := func(method, queue, operation, code string, status int) {
			t.Helper()
			_, err := call(method, queue, operation)
			var api *APIError
			if !errors.As(err, &api) || api.Code != code || api.Status != status {
				t.Fatalf("%s %s %s: %v", method, queue, operation, err)
			}
		}
		insert := func(id, kind, action, state string) {
			t.Helper()
			_, err := db.Collection("gojobs").InsertOne(ctx, M{"_id": id, "kind": kind, "resourceId": "shared", "action": action, "state": state, "createdAt": time.Now(), "attempts": 3})
			if err != nil {
				t.Fatal(err)
			}
		}
		state := func(id, want string) {
			t.Helper()
			row, err := s.Store.one(ctx, "gojobs", M{"_id": id})
			if err != nil || (want == "" && row != nil) || (want != "" && str(row["state"]) != want) {
				t.Fatalf("%s want %s got %v: %v", id, want, row, err)
			}
		}
		insert("repo:shared:remove", "repo", "remove", "failed")
		insert("gist:shared:expire", "gist", "expire", "failed")
		insert("pr:shared:prepare", "pr", "prepare", "failed")
		insert("repo:shared:cache", "repo", "cache", "active")
		_, err := db.Collection(collection("pr")).InsertOne(ctx, M{idKey("pr"): "shared", "status": "error", "source": M{"provider": "fixture"}})
		if err != nil {
			t.Fatal(err)
		}
		output, err := call("GET", "remove", "")
		if err != nil {
			t.Fatal(err)
		}
		result := output.(M)
		jobs := result["jobs"].([]M)
		if len(jobs) != 2 {
			t.Fatalf("expiry absent from remove queue: %v", jobs)
		}
		for _, queue := range result["queues"].([]M) {
			if queue["key"] == "remove" && number(obj(queue["counts"])["failed"]) != 2 {
				t.Fatal("expiry missing from counts", queue)
			}
		}
		for _, method := range []string{"POST", "DELETE"} {
			expectError(method, "download", "absent", "job_not_found", 404)
			expectError(method, "download", "gist:shared:expire", "job_not_found", 404)
			expectError(method, "unknown", "absent", "queue_not_found", 404)
		}
		expectError("POST", "cache", "repo:shared:cache", "job_is_active", 409)
		if _, err := call("POST", "download", "pr:shared:prepare"); err != nil {
			t.Fatal(err)
		}
		state("pr:shared:prepare", "waiting")
		resource, err := s.Store.one(ctx, collection("pr"), M{idKey("pr"): "shared"})
		if err != nil || resource["status"] != "preparing" {
			t.Fatal("document retry did not prepare its resource", resource, err)
		}
		if count, err := db.Collection("gojobs").CountDocuments(ctx, M{}); err != nil || count != 4 {
			t.Fatal("single retry created a different job", count, err)
		}
		output, err = call("POST", "remove", "retry-failed")
		if err != nil || number(obj(output)["total"]) != 2 || number(obj(output)["retried"]) != 2 {
			t.Fatal("remove retry omitted expiry", output, err)
		}
		state("gist:shared:expire", "waiting")
		state("repo:shared:remove", "waiting")
		insert("expiry-delayed", "gist", "expire", "delayed")
		if _, err := call("POST", "remove", "drain"); err != nil {
			t.Fatal(err)
		}
		state("gist:shared:expire", "")
		state("expiry-delayed", "")
		state("repo:shared:remove", "")
		state("pr:shared:prepare", "waiting")
		insert("expiry-completed", "gist", "expire", "completed")
		insert("expiry-active", "gist", "expire", "active")
		if _, err := call("POST", "remove", "empty"); err != nil {
			t.Fatal(err)
		}
		state("expiry-completed", "")
		state("expiry-active", "")
		insert("expiry-active", "gist", "expire", "active")
		if _, err := call("DELETE", "remove", "expiry-active"); err != nil {
			t.Fatal(err)
		}
		state("expiry-active", "")
		insert("empty", "gist", "expire", "failed")
		if _, err := call("DELETE", "remove", "empty"); err != nil {
			t.Fatal(err)
		}
		state("empty", "")
		state("pr:shared:prepare", "waiting")
		// Removing an active job must not let its old worker finish a replacement.
		if _, err := call("DELETE", "cache", "repo:shared:cache"); err != nil {
			t.Fatal(err)
		}
		if err := s.enqueue(ctx, "repo", "shared", "cache"); err != nil {
			t.Fatal(err)
		}
		changed, err := s.Store.update(ctx, "gojobs", M{"_id": "repo:shared:cache", "lease": "old-worker"}, M{"$set": M{"state": "completed"}})
		if err != nil || changed {
			t.Fatal("old worker changed replacement", err)
		}
		state("repo:shared:cache", "waiting")

		if _, err := db.Collection("gojobs").DeleteMany(ctx, M{}); err != nil {
			t.Fatal(err)
		}
		rows := []any{}
		states := []string{"active", "waiting", "delayed", "failed", "completed"}
		for _, status := range states {
			for i := 0; i < 201; i++ {
				rows = append(rows, M{"_id": fmt.Sprintf("%s-%03d", status, i), "kind": "repo", "resourceId": "resource-name", "action": "prepare", "state": status, "createdAt": time.Unix(int64(i), 0)})
			}
		}
		if _, err := db.Collection("gojobs").InsertMany(ctx, rows); err != nil {
			t.Fatal(err)
		}
		output, err = call("GET", "unknown", "")
		if err != nil {
			t.Fatal(err)
		}
		result = output.(M)
		jobs = result["jobs"].([]M)
		if result["selectedQueue"] != "download" || len(jobs) != 1000 {
			t.Fatal("queue fallback or per-state bounds differ", result["selectedQueue"], len(jobs))
		}
		for i, job := range jobs {
			if job["_state"] != states[i/200] {
				t.Fatal("job priority order differs", i, job)
			}
		}
		output, err = s.adminQueues(&request{Server: s, R: httptest.NewRequest("GET", "/?search=ACTIVE-200", nil), Params: map[string]string{}})
		if err != nil {
			t.Fatal(err)
		}
		jobs = output.(M)["jobs"].([]M)
		if len(jobs) != 1 || jobs[0]["id"] != "active-200" {
			t.Fatal("job ID search differs", jobs)
		}
	})
}
