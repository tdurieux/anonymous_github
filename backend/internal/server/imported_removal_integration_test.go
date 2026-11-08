package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runImportedRemovalIntegration(t *testing.T, base *Server) {
	for _, mode := range []string{"single", "bulk", "automatic"} {
		t.Run("imported removal retries "+mode, func(t *testing.T) {
			ctx := context.Background()
			db := base.Store.DB.Client().Database("imported_remove_" + bson.NewObjectID().Hex())
			defer db.Drop(ctx)
			s := &Server{Store: &Store{DB: db, Redis: base.Store.Redis}, content: base.content}
			created := time.Now().UTC().Truncate(time.Millisecond)
			type fixture struct {
				name, status                                                         string
				anonymized                                                           any
				missing, banned, ordinary, wrongQueue, noTimestamp, restore, removed bool
			}
			cases := []fixture{
				{name: "older error", status: "error", anonymized: created.Add(-time.Hour), removed: true},
				{name: "equal date", status: "error", anonymized: created, removed: true},
				{name: "missing date", status: "error", missing: true, removed: true},
				{name: "newer error", status: "error", anonymized: created.Add(time.Hour)},
				{name: "restored ready", status: "ready", anonymized: created.Add(-time.Hour)},
				{name: "banned ready", status: "ready", anonymized: created, banned: true, removed: true},
				{name: "banned newer error", status: "error", anonymized: created.Add(time.Hour), banned: true, removed: true},
				{name: "already removed", status: "removed", missing: true, banned: true, removed: true},
				{name: "expired", status: "expired", missing: true},
				{name: "null date", status: "error", anonymized: nil},
				{name: "string date", status: "error", anonymized: created.Add(-time.Hour).Format(time.RFC3339Nano)},
				{name: "ordinary Go failure", status: "error", missing: true, ordinary: true},
				{name: "wrong source queue", status: "error", missing: true, wrongQueue: true},
				{name: "missing timestamp", status: "error", missing: true, noTimestamp: true},
				{name: "restored after retry", status: "error", missing: true, restore: true},
			}
			ids := make([]string, len(cases))
			for i, c := range cases {
				id := "imported-remove-" + bson.NewObjectID().Hex()
				ids[i] = id
				owner := bson.NewObjectID()
				status := "active"
				if c.banned {
					status = "banned"
				}
				if _, err := db.Collection("users").InsertOne(ctx, M{"_id": owner, "status": status}); err != nil {
					t.Fatal(err)
				}
				resource := M{"repoId": id, "status": c.status, "statusDate": created, "owner": owner, "source": M{"provider": "fixture"}, "providerAccess": M{"revision": "binding:1"}}
				if !c.missing {
					resource["anonymizeDate"] = c.anonymized
				}
				if _, err := db.Collection(collection("repo")).InsertOne(ctx, resource); err != nil {
					t.Fatal(err)
				}
				if _, err := db.Collection("files").InsertOne(ctx, M{"repoId": id, "name": "kept-unless-removed.txt"}); err != nil {
					t.Fatal(err)
				}
				const content = "retained fixture bytes"
				if err := s.content.Put(ctx, id, "cached.bin", strings.NewReader(content), int64(len(content)), 1024); err != nil {
					t.Fatal(err)
				}
				defer s.content.Remove(ctx, id, "")

				job := M{"_id": id, "kind": "repo", "resourceId": id, "action": "remove", "state": "failed", "attempts": 3, "createdAt": created, "migration": M{"version": 1, "sourceQueue": "repository removal"}}
				if c.ordinary {
					delete(job, "migration")
				}
				if c.wrongQueue {
					obj(job["migration"])["sourceQueue"] = "repository download"
				}
				if c.noTimestamp {
					delete(job, "createdAt")
				}
				if _, err := db.Collection("gojobs").InsertOne(ctx, job); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "automatic" {
				defer base.Store.Redis.Del(ctx, "go:pause:remove")
				s.removalRecoveryPending.Store(true)
				if _, err := db.Collection("gojobs").InsertOne(ctx, M{"_id": "active-import", "kind": "repo", "action": "remove", "state": "active", "lease": "live-worker", "migration": M{"version": 1, "sourceQueue": "repository removal"}}); err != nil {
					t.Fatal(err)
				}
				if err := base.Store.Redis.Set(ctx, "go:pause:remove", "1", 0).Err(); err != nil {
					t.Fatal(err)
				}
				if err := s.recoverImportedRemovalJobs(ctx); err != nil {
					t.Fatal(err)
				}
				if n, err := db.Collection("gojobs").CountDocuments(ctx, M{"state": "waiting"}); err != nil || n != 0 {
					t.Fatal("paused queue recovered jobs", n, err)
				}
				if !s.removalRecoveryPending.Load() {
					t.Fatal("paused startup recovery was discarded")
				}
				if err := base.Store.Redis.Del(ctx, "go:pause:remove").Err(); err != nil {
					t.Fatal(err)
				}
				if err := s.recoverImportedRemovalJobs(ctx); err != nil {
					t.Fatal(err)
				}
				active, err := s.Store.one(ctx, "gojobs", M{"_id": "active-import"})
				if err != nil || active["state"] != "active" || active["lease"] != "live-worker" {
					t.Fatal("active imported job overwritten", active, err)
				}
			}
			if mode == "bulk" {
				result, err := s.retryFailedJobs(ctx, "remove")
				if err != nil || number(result["retried"]) != int64(len(cases)) {
					t.Fatal(result, err)
				}
			}
			for i, c := range cases {
				t.Run(c.name, func(t *testing.T) {
					id := ids[i]
					if mode == "single" {
						if _, err := s.adminJob(&request{Server: s, R: httptest.NewRequest("POST", "/", nil)}, id, []string{"remove"}); err != nil {
							t.Fatal(err)
						}
					}
					before, err := s.Store.one(ctx, collection("repo"), M{"repoId": id})
					if err != nil || before["status"] != c.status {
						t.Fatal("retry changed resource before execution", before, err)
					}
					want := c.status
					if c.restore {
						if _, err := s.Store.update(ctx, collection("repo"), M{"repoId": id}, M{"$set": M{"status": "ready", "anonymizeDate": created.Add(time.Second)}}); err != nil {
							t.Fatal(err)
						}
						want = "ready"
					}
					if mode == "automatic" && (c.ordinary || c.wrongQueue) {
						job, err := s.Store.one(ctx, "gojobs", M{"_id": id})
						if err != nil || job["state"] != "failed" {
							t.Fatal("unrelated job recovered", job, err)
						}
						return
					}
					job, err := s.Store.one(ctx, "gojobs", M{"_id": id})
					if err != nil || job["state"] != "waiting" {
						t.Fatal(job, err)
					}
					if err := s.runJob(ctx, job); err != nil {
						t.Fatal(err)
					}
					current, err := s.Store.one(ctx, collection("repo"), M{"repoId": id})
					if err != nil {
						t.Fatal(err)
					}
					if c.removed {
						want = "removed"
					}
					if current["status"] != want {
						t.Fatalf("want %s, got %v", want, current)
					}
					count, err := db.Collection("files").CountDocuments(ctx, M{"repoId": id})
					if err != nil {
						t.Fatal(err)
					}
					wantFiles := int64(1)
					if c.removed && c.status != "removed" {
						wantFiles = 0
					}
					if count != wantFiles {
						t.Fatalf("file cleanup crossed lifecycle guard: %d, want %d", count, wantFiles)
					}
					size, err := s.content.Size(ctx, id, "cached.bin")
					if wantFiles == 0 {
						if !os.IsNotExist(err) {
							t.Fatal("eligible removal retained cached bytes", size, err)
						}
					} else if err != nil || size != int64(len("retained fixture bytes")) {
						t.Fatal("stale removal deleted cached bytes", size, err)
					}

				})
			}
			if mode == "automatic" {
				id := ids[0]
				if _, err := s.Store.update(ctx, "gojobs", M{"_id": id}, M{"$set": M{"state": "failed", "attempts": 7}}); err != nil {
					t.Fatal(err)
				}
				if err := s.recoverImportedRemovalJobs(ctx); err != nil {
					t.Fatal(err)
				}
				job, err := s.Store.one(ctx, "gojobs", M{"_id": id})
				if err != nil || job["state"] != "failed" || number(job["attempts"]) != 7 {
					t.Fatal("automatic recovery repeated", job, err)
				}
				// A later process startup retries again, as TypeScript does;
				// periodic maintenance within one startup must not do so.
				s.removalRecoveryPending.Store(true)
				if err := s.recoverImportedRemovalJobs(ctx); err != nil {
					t.Fatal(err)
				}
				job, err = s.Store.one(ctx, "gojobs", M{"_id": id})
				if err != nil || job["state"] != "waiting" || number(job["attempts"]) != 0 || s.removalRecoveryPending.Load() {
					t.Fatal("startup recovery did not resume", job, err)
				}

			}
			// Revision changes during recovery must win even if statusDate is unchanged.
			for _, field := range []string{"owner", "anonymizeDate", "providerAccess.revision"} {
				id := "claim-race-" + bson.NewObjectID().Hex()
				resource := M{"_id": bson.NewObjectID(), "repoId": id, "status": "error", "owner": bson.NewObjectID(), "statusDate": created, "anonymizeDate": created.Add(-time.Hour), "source": M{"provider": "fixture"}, "providerAccess": M{"revision": "original"}}
				if _, err := db.Collection(collection("repo")).InsertOne(ctx, resource); err != nil {
					t.Fatal(err)
				}
				value := any(bson.NewObjectID())
				if field == "anonymizeDate" {
					value = created.Add(time.Hour)
				}
				if field == "providerAccess.revision" {
					value = "replacement"
				}
				if _, err := s.Store.update(ctx, collection("repo"), M{"_id": resource["_id"]}, M{"$set": M{field: value}}); err != nil {
					t.Fatal(err)
				}
				job := M{"kind": "repo", "action": "remove", "createdAt": created, "migration": M{"version": 1, "sourceQueue": "repository removal"}}
				claimed, err := s.recoverImportedRemoval(ctx, job, resource)
				if err != nil || claimed != nil {
					t.Fatal(fmt.Sprintf("stale %s claim succeeded", field), claimed, err)
				}
			}
		})
	}
}
