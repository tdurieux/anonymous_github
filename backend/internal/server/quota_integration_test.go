package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runQuotaIntegration(t *testing.T, s *Server) {
	t.Run("quota uses valid caches and only current owned trees", func(t *testing.T) {
		ctx := context.Background()
		owner, other := bson.NewObjectID(), bson.NewObjectID()
		token := "synthetic-quota-user"
		if _, err := s.Store.DB.Collection("users").InsertOne(ctx, M{"_id": owner, "username": "quota-fixture", "status": "active", "apiTokens": []M{{"tokenHash": security.HashToken(token)}}}); err != nil {
			t.Fatal(err)
		}
		before := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
		records := map[string]M{
			"positive":        {"size": M{"storage": 100, "file": 2}},
			"empty":           {"size": M{"storage": 0, "file": 0}, "sizeComputedAt": before},
			"current":         {"treeGeneration": "current", "fileMetadataRevision": "first"},
			"legacy":          {"size": M{"storage": 0, "file": 0}},
			"missing-storage": {"size": M{"file": 9}, "sizeComputedAt": before},
			"overdue":         {"size": M{"storage": 777, "file": 77}, "options": M{"expirationDate": before}},
			"never":           {"size": M{"storage": 20, "file": 1}, "options": M{"expirationMode": "never", "expirationDate": before}},
			"other":           {"owner": other, "size": M{"storage": 9999, "file": 999}, "coauthors": []M{{"username": "quota-fixture"}}},
			"inactive":        {"status": "preparing", "size": M{"storage": 888, "file": 88}},
		}
		for name, row := range records {
			defaults(row, M{"_id": bson.NewObjectID(), "repoId": "quota-" + name, "owner": owner, "status": "ready", "options": M{}, "source": M{"provider": "fixture"}})
			if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, row); err != nil {
				t.Fatal(err)
			}
		}
		addFile := func(name, path, generation string, size int64) {
			t.Helper()
			row := M{"repoId": "quota-" + name, "path": "", "name": path, "size": size}
			if generation != "" {
				row["treeGeneration"] = generation
			}
			if _, err := s.Store.DB.Collection("files").InsertOne(ctx, row); err != nil {
				t.Fatal(err)
			}
		}
		addFile("positive", "ignored", "", 999)
		addFile("empty", "ignored", "", 999)
		addFile("current", "a", "current", 7)
		addFile("current", "b", "current", 11)
		addFile("current", "old", "old", 999)
		addFile("legacy", "a", "", 3)
		addFile("legacy", "old", "old", 500)
		addFile("missing-storage", "a", "", 5)
		call := func() M {
			t.Helper()
			req := httptest.NewRequest("GET", "/api/user/quota", nil)
			req.RemoteAddr = "198.51.100.21:1234"
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body)
			}
			var out M
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			return out
		}
		check := func(out M) {
			t.Helper()
			if number(obj(out["storage"])["used"]) != 146 || number(obj(out["file"])["used"]) != 7 || number(obj(out["repository"])["used"]) != 6 {
				t.Fatal(out)
			}
		}
		check(call())
		for name, want := range map[string]int64{"current": 18, "legacy": 3, "missing-storage": 5} {
			row, err := s.Store.one(ctx, collection("repo"), M{"repoId": "quota-" + name})
			if err != nil {
				t.Fatal(err)
			}
			if number(obj(row["size"])["storage"]) != want || !date(row["sizeComputedAt"]).After(before) {
				t.Fatal("cache not saved", name, row)
			}
		}
		addFile("current", "later", "current", 100)
		check(call())
		row, err := s.Store.one(ctx, collection("repo"), M{"repoId": "quota-current"})
		if err != nil {
			t.Fatal(err)
		}
		for _, change := range []M{{"fileMetadataRevision": "new"}, {"fileMetadataRevision": "first", "treeGeneration": "replacement"}, {"treeGeneration": "current", "status": "removing"}} {
			if _, err := s.Store.update(ctx, collection("repo"), M{"_id": row["_id"]}, M{"$set": change}); err != nil {
				t.Fatal(err)
			}
			if err := s.cacheQuotaSize(ctx, row, M{"storage": 9999, "file": 999}, time.Now()); err != nil {
				t.Fatal(err)
			}
			current, err := s.Store.one(ctx, collection("repo"), M{"_id": row["_id"]})
			if err != nil {
				t.Fatal(err)
			}
			if number(obj(current["size"])["storage"]) != 18 {
				t.Fatal("stale calculation overwrote newer revision", current)
			}
		}
	})
}
