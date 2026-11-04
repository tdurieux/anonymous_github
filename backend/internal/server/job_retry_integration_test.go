package server

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/event"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func runJobRetryIntegration(t *testing.T, base *Server) {
	t.Run("failed job retries isolate failures and cover the full snapshot", func(t *testing.T) {
		ctx := context.Background()
		db := base.Store.DB.Client().Database("job_retry_" + bson.NewObjectID().Hex())
		defer db.Drop(ctx)
		s := &Server{Store: &Store{DB: db, Redis: base.Store.Redis}}
		const invalid = 100000
		jobs := make([]any, 0, invalid+5)
		for i := 0; i < invalid; i++ {
			jobs = append(jobs, M{"_id": fmt.Sprintf("invalid-%06d", i), "kind": "unsupported", "action": "prepare", "state": "failed", "resourceId": "unused"})
		}
		for _, id := range []string{"tail", "bad", "became-active"} {
			jobs = append(jobs, M{"_id": id, "kind": "repo", "action": "prepare", "state": "failed", "resourceId": id, "attempts": 3})
		}
		jobs = append(jobs, M{"_id": "already-active", "kind": "repo", "action": "prepare", "state": "active", "resourceId": "already-active"}, M{"_id": "remove-good", "kind": "repo", "action": "remove", "state": "failed", "resourceId": "untouched"})
		if _, err := db.Collection("gojobs").InsertMany(ctx, jobs); err != nil {
			t.Fatal(err)
		}
		for _, id := range []string{"tail", "bad", "became-active", "untouched"} {
			status := "error"
			if id == "became-active" {
				status = "ready"
			}
			if _, err := db.Collection(collection("repo")).InsertOne(ctx, M{"repoId": id, "status": status, "source": M{"provider": "fixture"}}); err != nil {
				t.Fatal(err)
			}
		}
		if err := db.RunCommand(ctx, bson.D{{Key: "collMod", Value: collection("repo")}, {Key: "validator", Value: M{"$or": []M{{"repoId": M{"$ne": "bad"}}, {"status": "error"}}}}, {Key: "validationLevel", Value: "strict"}, {Key: "validationAction", Value: "error"}}).Err(); err != nil {
			t.Fatal(err)
		}
		var once sync.Once
		monitor := &event.CommandMonitor{Started: func(_ context.Context, e *event.CommandStartedEvent) {
			if e.CommandName != "update" || e.Command.Lookup("update").StringValue() != collection("repo") {
				return
			}
			once.Do(func() {
				// These writes occur after the failed-job snapshot was read.
				if _, err := db.Collection("gojobs").InsertOne(ctx, M{"_id": "late", "kind": "repo", "resourceId": "late", "action": "prepare", "state": "failed"}); err != nil {
					t.Error(err)
				}
				if _, err := db.Collection(collection("repo")).InsertOne(ctx, M{"repoId": "late", "status": "error"}); err != nil {
					t.Error(err)
				}
				if _, err := db.Collection("gojobs").UpdateOne(ctx, M{"_id": "became-active"}, M{"$set": M{"state": "active"}}); err != nil {
					t.Error(err)
				}
			})
		}}
		observed, err := mongo.Connect(options.Client().ApplyURI(os.Getenv("GO_TEST_MONGODB_URI")).SetBSONOptions(&options.BSONOptions{DefaultDocumentM: true}).SetMonitor(monitor))
		if err != nil {
			t.Fatal(err)
		}
		defer observed.Disconnect(ctx)
		s.Store.DB = observed.Database(db.Name())
		result, err := s.retryFailedJobs(ctx, "prepare")
		s.Store.DB = db
		if err != nil || number(result["total"]) != invalid+3 || number(result["retried"]) != 1 {
			t.Fatal("wrong snapshot/partial retry counts", result, err)
		}
		for id, want := range map[string]string{"tail": "waiting", "bad": "failed", "late": "failed", "became-active": "active", "already-active": "active", "remove-good": "failed", "invalid-099999": "failed"} {
			row, err := s.Store.one(ctx, "gojobs", M{"_id": id})
			if err != nil || row["state"] != want {
				t.Fatal("job state changed incorrectly", id, row["state"], want, err)
			}
			if id == "tail" && number(row["attempts"]) != 0 {
				t.Fatal("attempts not reset")
			}
		}
		for id, want := range map[string]string{"tail": "preparing", "bad": "error", "late": "error", "became-active": "ready", "untouched": "error"} {
			row, err := s.Store.one(ctx, collection("repo"), M{"repoId": id})
			if err != nil || row["status"] != want {
				t.Fatal("resource state changed incorrectly", id, row["status"], want, err)
			}
		}
		// A job-state write failure must not prevent other retries in the same queue.
		if _, err := db.Collection("gojobs").InsertOne(ctx, M{"_id": "remove-bad", "action": "remove", "state": "failed"}); err != nil {
			t.Fatal(err)
		}
		if err := db.RunCommand(ctx, bson.D{{Key: "collMod", Value: "gojobs"}, {Key: "validator", Value: M{"$or": []M{{"_id": M{"$ne": "remove-bad"}}, {"state": "failed"}}}}, {Key: "validationLevel", Value: "strict"}, {Key: "validationAction", Value: "error"}}).Err(); err != nil {
			t.Fatal(err)
		}
		result, err = s.retryFailedJobs(ctx, "remove")
		if err != nil || number(result["total"]) != 2 || number(result["retried"]) != 1 {
			t.Fatal("job write failure stopped retries", result, err)
		}
		bad, err := s.Store.one(ctx, "gojobs", M{"_id": "remove-bad"})
		if err != nil || bad["state"] != "failed" {
			t.Fatal("failed retry lost job", err)
		}
	})
}
