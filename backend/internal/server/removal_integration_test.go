package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runRepositoryRemovalIntegration(t *testing.T, s *Server, token, otherToken string) {
	ctx := context.Background()
	source, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
	if err != nil {
		t.Fatal(err)
	}
	insert := func(id, status string) M {
		t.Helper()
		r := selectFields(source, "owner", "source", "providerAccess", "options")
		r["_id"], r["repoId"], r["status"] = bson.NewObjectID(), id, status
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	call := func(id, credential string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("DELETE", "/api/repo/"+id, nil)
		request.RemoteAddr = "198.51.100.4:1234"
		request.Header.Set("Authorization", "Bearer "+credential)
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		return response
	}
	t.Run("stale removal snapshot preserves restored content", func(t *testing.T) {
		id := "removal-restored-snapshot"
		r := insert(id, "removing")
		oldPath := contentPrefix(r) + "/file"
		if err := s.content.Put(ctx, id, oldPath, strings.NewReader("old"), 3, 3); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"files", "anonymizedpaths"} {
			if _, err := s.Store.DB.Collection(name).InsertOne(ctx, M{"repoId": id, "name": "old"}); err != nil {
				t.Fatal(err)
			}
		}
		snapshot, err := s.snapshotRemoval(ctx, r)
		if err != nil || snapshot == nil {
			t.Fatal(snapshot, err)
		}
		// Another worker completes removal before this worker resumes deletion.
		if err := s.runJob(ctx, M{"kind": "repo", "resourceId": id, "action": "remove"}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"status": "ready", "treeGeneration": "restored-generation"}}); err != nil {
			t.Fatal(err)
		}
		restored := M{"treeGeneration": "restored-generation"}
		newPath := contentPrefix(restored) + "/file"
		if err := s.content.Put(ctx, id, newPath, strings.NewReader("new"), 3, 3); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"files", "anonymizedpaths"} {
			if _, err := s.Store.DB.Collection(name).InsertOne(ctx, M{"repoId": id, "name": "new"}); err != nil {
				t.Fatal(err)
			}
		}
		for i := 0; i < 2; i++ {
			if err := s.deleteRemovalSnapshot(ctx, id, snapshot); err != nil {
				t.Fatal(err)
			}
		}
		if size, err := s.content.Size(ctx, id, newPath); err != nil || size != 3 {
			t.Fatal("restored content removed", size, err)
		}
		for _, name := range []string{"files", "anonymizedpaths"} {
			if n, err := s.Store.DB.Collection(name).CountDocuments(ctx, M{"repoId": id}); err != nil || n != 1 {
				t.Fatal(name, n, err)
			}
		}
		if snapshot, err := s.snapshotRemoval(ctx, r); err != nil || snapshot != nil {
			t.Fatal("stale revision accepted", snapshot, err)
		}
	})
	t.Run("repository removal state matrix", func(t *testing.T) {
		for _, status := range []string{"ready", "preparing", "queue", "download", "error", "expired", "expiring", "removing", "removed", "archived"} {
			id := "removal-state-" + status
			insert(id, status)
			w := call(id, token)
			var body M
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if status == "removed" || status == "archived" {
				code := "is_removed"
				if status == "archived" {
					code = "repository_archived"
				}
				if w.Code != 410 || body["error"] != code {
					t.Fatalf("%s: %d %s", status, w.Code, w.Body)
				}
				continue
			}
			if w.Code != 200 || body["status"] != "removing" {
				t.Fatalf("%s: %d %s", status, w.Code, w.Body)
			}
			if err := s.content.Put(ctx, id, "raw", strings.NewReader("raw"), 3, 3); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Store.DB.Collection("files").InsertOne(ctx, M{"repoId": id, "path": "", "name": "raw", "size": 3}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Store.DB.Collection("anonymizedpaths").InsertOne(ctx, M{"repoId": id, "path": "raw"}); err != nil {
				t.Fatal(err)
			}
			job, err := s.Store.one(ctx, "gojobs", M{"_id": "repo:" + id + ":remove"})
			if err != nil || job == nil || job["state"] != "waiting" {
				t.Fatal(job, err)
			}
			if err := s.runJob(ctx, job); err != nil {
				t.Fatal(err)
			}
			current, err := s.Store.one(ctx, collection("repo"), M{"repoId": id})
			if err != nil || current["status"] != "removed" || !boolean(current["isReseted"]) {
				t.Fatal(current, err)
			}
			for _, coll := range []string{"files", "anonymizedpaths"} {
				count, err := s.Store.DB.Collection(coll).CountDocuments(ctx, M{"repoId": id})
				if err != nil || count != 0 {
					t.Fatal(coll, count, err)
				}
			}
			rows, err := s.content.List(ctx, id)
			if (err != nil && !errors.Is(err, fs.ErrNotExist)) || len(rows) != 0 {
				t.Fatal(rows, err)
			}
			if w := call(id, token); w.Code != 410 {
				t.Fatal("repeated deletion", w.Code, w.Body)
			}
		}
	})
	t.Run("removal requires ownership", func(t *testing.T) {
		insert("removal-not-owner", "ready")
		if w := call("removal-not-owner", otherToken); w.Code != 403 {
			t.Fatal(w.Code, w.Body)
		}
	})
	t.Run("removal survives enqueue failure", func(t *testing.T) {
		id := "removal-queue-failure"
		insert(id, "ready")
		command := func(validator M) error {
			return s.Store.DB.RunCommand(ctx, bson.D{{Key: "collMod", Value: "gojobs"}, {Key: "validator", Value: validator}, {Key: "validationLevel", Value: "strict"}, {Key: "validationAction", Value: "error"}}).Err()
		}
		if err := command(M{"_id": M{"$ne": "repo:" + id + ":remove"}}); err != nil {
			t.Fatal(err)
		}
		defer command(M{})
		if w := call(id, token); w.Code != 500 {
			t.Fatal(w.Code, w.Body)
		}
		current, err := s.Store.one(ctx, collection("repo"), M{"repoId": id})
		if err != nil || current["status"] != "removing" {
			t.Fatal("removal intent lost", current, err)
		}
		if err := s.checkResource(ctx, "repo", current); err == nil {
			t.Fatal("removing content remained public")
		}
		if err := command(M{}); err != nil {
			t.Fatal(err)
		}
		if w := call(id, token); w.Code != 200 {
			t.Fatal("retry failed", w.Code, w.Body)
		}
		if err := s.runJob(ctx, M{"kind": "repo", "resourceId": id, "action": "remove"}); err != nil {
			t.Fatal(err)
		}
		current, err = s.Store.one(ctx, collection("repo"), M{"repoId": id})
		if err != nil || current["status"] != "removed" {
			t.Fatal(current, err)
		}
	})
}
