package server

import (
	"go.mongodb.org/mongo-driver/v2/bson"
	"testing"
)

func runWebsiteLookupIntegration(t *testing.T, s *Server) {
	t.Run("website indexed lookup and grouped folder counts", func(t *testing.T) {
		ctx := t.Context()
		id := "website-index-" + bson.NewObjectID().Hex()
		repo := M{"_id": bson.NewObjectID(), "repoId": id, "status": "ready", "treeGeneration": "fixture", "options": M{"terms": []string{"alice => shared", "bob => shared"}}}
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
			t.Fatal(err)
		}
		defer s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": id})
		defer s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": id})
		rows := []any{}
		for _, row := range []M{
			{"path": "", "name": "unique.txt", "size": 1, "sha": "unique"},
			{"path": "alice", "name": "index.html", "size": 1, "sha": "first"},
			{"path": "bob", "name": "index.html", "size": 1, "sha": "second"},
			{"path": "alice/sub", "name": "empty.txt", "size": 0},
			{"path": "alice", "name": "sub"},
			{"path": "bob", "name": "folder", "size": nil},
		} {
			row["repoId"] = id
			row["treeGeneration"] = "fixture"
			rows = append(rows, row)
		}
		if _, err := s.Store.DB.Collection("files").InsertMany(ctx, rows); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			row, err := s.indexedWebFile(ctx, repo, "unique.txt")
			if err != nil || row["sha"] != "unique" {
				t.Fatal(row, err)
			}
			for _, p := range []string{"shared/index.html", "shared"} {
				if _, err := s.indexedWebFile(ctx, repo, p); err == nil || err.Error() != "ambiguous_anonymized_path" {
					t.Fatal("collision accepted", p, err)
				}
			}
			if row, err := s.indexedWebFile(ctx, repo, "missing"); err != nil || row != nil {
				t.Fatal(row, err)
			}
		}
		counts, err := s.folderCounts(ctx, repo)
		if err != nil || number(counts[""]) != 4 || number(counts["shared"]) != 3 || number(counts["shared/sub"]) != 1 || len(counts) != 3 {
			t.Fatal(counts, err)
		}
		// Changing settings must not reuse a collision or resolved row from old terms.
		old := s.pathIndexKey(repo)
		repo["options"] = M{"terms": []string{}}
		if _, err := s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": M{"options": repo["options"]}}); err != nil {
			t.Fatal(err)
		}
		if row, err := s.indexedWebFile(ctx, repo, "shared/index.html"); err != nil || row != nil {
			t.Fatal("old settings reused", row, err)
		}
		if row, err := s.indexedWebFile(ctx, repo, "alice/index.html"); err != nil || row["sha"] != "first" {
			t.Fatal(row, err)
		}
		// Ordinary unchanged paths must not build a full index, even on a cold read.
		plainKey := s.pathIndexKey(repo)
		s.Store.Redis.Del(ctx, plainKey)
		if row, err := s.indexedWebFile(ctx, repo, "unique.txt"); err != nil || row == nil {
			t.Fatal(row, err)
		}
		if s.Store.Redis.Exists(ctx, plainKey).Val() != 0 {
			t.Fatal("ordinary file built full index")
		}
		duplicate := M{"repoId": id, "treeGeneration": "fixture", "path": "", "name": "unique.txt", "size": 1, "sha": "duplicate"}
		result, err := s.Store.DB.Collection("files").InsertOne(ctx, duplicate)
		if err != nil {
			t.Fatal(err)
		}
		repo["fileMetadataRevision"] = "duplicate-added"
		if _, err := s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": M{"fileMetadataRevision": repo["fileMetadataRevision"]}}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.indexedWebFile(ctx, repo, "unique.txt"); err == nil || err.Error() != "ambiguous_anonymized_path" {
			t.Fatal("duplicate original accepted", err)
		}
		s.Store.DB.Collection("files").DeleteOne(ctx, M{"_id": result.InsertedID})
		// Eviction rebuilds safely; deletion invalidates even a ready cached index.
		key := s.pathIndexKey(repo)
		if err := s.Store.Redis.Del(ctx, key).Err(); err != nil {
			t.Fatal(err)
		}
		if row, err := s.indexedWebFile(ctx, repo, "unique.txt"); err != nil || row == nil {
			t.Fatal(row, err)
		}
		s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": id})
		if _, err := s.indexedWebFile(ctx, repo, "unique.txt"); err == nil || err.Error() != "repository_changed" {
			t.Fatal("removed repository accepted", err)
		}
		s.Store.Redis.Del(ctx, old, key)
	})
}
