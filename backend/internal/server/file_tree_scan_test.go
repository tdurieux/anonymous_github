package server

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// The last row is deliberately beyond the former 100,000-row scan cap.
func runFileTreeScanIntegration(t *testing.T, s *Server) {
	t.Run("large file tree scan", func(t *testing.T) {
		ctx := t.Context()
		id := "large-tree-" + bson.NewObjectID().Hex()
		repo := M{"_id": bson.NewObjectID(), "repoId": id, "status": "ready", "treeGeneration": "fixture", "options": M{"terms": []string{}, "expirationMode": "never"}}
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
			t.Fatal(err)
		}
		defer s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": id})
		defer s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": id})
		batch := make([]any, 0, 1000)
		for i := 0; i < 100001; i++ {
			path, name := "early", fmt.Sprintf("file-%06d", i)
			if i == 100000 {
				path, name = "zz-tail", "unique-tail.txt"
			}
			batch = append(batch, M{"repoId": id, "treeGeneration": "fixture", "path": path, "name": name, "size": 1})
			if len(batch) == 1000 || i == 100000 {
				if _, err := s.Store.DB.Collection("files").InsertMany(ctx, batch); err != nil {
					t.Fatal(err)
				}
				batch = batch[:0]
			}
		}
		get := func(suffix string) *httptest.ResponseRecorder {
			t.Helper()
			r := httptest.NewRequest("GET", "/api/repo/"+id+"/files"+suffix, nil)
			r.RemoteAddr = "198.51.100.64:1234"
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != 200 {
				t.Fatal(suffix, w.Code, w.Body)
			}
			return w
		}
		for _, suffix := range []string{"?path=zz-tail", "/search?q=unique-tail"} {
			var result []M
			if err := json.Unmarshal(get(suffix).Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if len(result) != 1 || result[0]["name"] != "unique-tail.txt" {
				t.Fatal(suffix, result)
			}
		}
		repo["options"] = M{"terms": []string{"unique-tail => transformed"}}
		repo["fileMetadataRevision"] = "large-test"
		if _, err := s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": M{"options": repo["options"], "fileMetadataRevision": "large-test"}}); err != nil {
			t.Fatal(err)
		}
		row, err := s.indexedFile(ctx, repo, "zz-tail/transformed.txt")
		if err != nil || str(row["name"]) != "unique-tail.txt" {
			t.Fatal("index truncated final row", row, err)
		}

		var counts M
		if err := json.Unmarshal(get("/counts").Body.Bytes(), &counts); err != nil {
			t.Fatal(err)
		}
		if number(counts[""]) != 100001 || number(counts["zz-tail"]) != 1 {
			t.Fatal(counts)
		}
		var matches []M
		if err := json.Unmarshal(get("/search?q=file").Body.Bytes(), &matches); err != nil {
			t.Fatal(err)
		}
		if len(matches) != 500 {
			t.Fatal("search result cap", len(matches))
		}
	})
}
