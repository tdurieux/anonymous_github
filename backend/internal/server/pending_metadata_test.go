package server

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runPendingMetadataIntegration(t *testing.T, s *Server) {
	t.Run("pending file metadata transformed lookup", func(t *testing.T) {
		for _, stale := range []bool{false, true} {
			t.Run(map[bool]string{false: "valid", true: "stale"}[stale], func(t *testing.T) {
				ctx := t.Context()
				id := "pending-index-" + bson.NewObjectID().Hex()
				repo := M{"_id": bson.NewObjectID(), "repoId": id, "status": "ready", "treeGeneration": "current", "fileMetadataRevision": "before", "source": M{"provider": "fixture", "commit": "current"}, "options": M{"terms": []string{"alice => shared"}}}
				if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
					t.Fatal(err)
				}
				defer s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": id})
				defer s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": id})
				snapshot := pathSnapshotFilter(repo)
				delete(snapshot, "fileMetadataRevision")
				if stale {
					snapshot["source.commit"] = "retired"
				}
				for _, name := range []string{"alice-one.txt", "alice-two.txt"} {
					if _, err := s.Store.DB.Collection("files").InsertOne(ctx, M{"repoId": id, "treeGeneration": "current", "path": "", "name": name, "sha": "blob", "size": 1, "metadataPending": true, "recoverySnapshot": snapshot}); err != nil {
						t.Fatal(err)
					}
				}
				row, err := s.indexedFile(ctx, repo, "shared-one.txt")
				if stale {
					if err == nil || err.Error() != "repository_changed" || row != nil {
						t.Fatal("stale pending metadata served", row, err)
					}
					count, e := s.Store.DB.Collection("files").CountDocuments(ctx, M{"repoId": id, "name": "alice-one.txt"})
					if e != nil || count != 0 {
						t.Fatal("stale row retained", count, e)
					}
					return
				}
				if err != nil || row["sha"] != "blob" {
					t.Fatal(row, err)
				}
				current, err := s.Store.one(ctx, collection("repo"), M{"repoId": id})
				if err != nil || current["fileMetadataRevision"] == "before" {
					t.Fatal("metadata revision not repaired", current, err)
				}
				if count, err := s.Store.DB.Collection("files").CountDocuments(ctx, M{"repoId": id, "metadataPending": true}); err != nil || count != 0 {
					t.Fatal("pending metadata not repaired", count, err)
				}
				if row, err := s.indexedFile(ctx, current, "shared-two.txt"); err != nil || row["sha"] != "blob" {
					t.Fatal("repaired index unavailable", row, err)
				}
			})
		}
	})

	t.Run("pending file metadata maintenance", func(t *testing.T) {
		ctx := t.Context()
		prefix := "pending-" + bson.NewObjectID().Hex()
		ids := []string{}
		defer func() {
			s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": M{"$in": ids}})
			s.Store.DB.Collection(collection("repo")).DeleteMany(ctx, M{"repoId": M{"$in": ids}})
		}()
		for _, kind := range []string{"ready", "legacy", "missing", "generation", "expired", "removing", "archived", "stale-source"} {
			id := prefix + "-" + kind
			ids = append(ids, id)
			repo := M{"_id": bson.NewObjectID(), "repoId": id, "status": "ready", "treeGeneration": "current", "fileMetadataRevision": "before", "options": M{"terms": []string{}}}
			if kind == "legacy" {
				delete(repo, "treeGeneration")
			}
			if kind == "expired" || kind == "removing" || kind == "archived" {
				repo["status"] = kind
			}
			if kind != "missing" {
				if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
					t.Fatal(err)
				}
			}
			row := M{"repoId": id, "path": "", "name": "file.txt", "size": 1, "sha": "opaque", "metadataPending": true}
			if kind != "legacy" {
				row["treeGeneration"] = "current"
			}
			if kind == "generation" {
				row["treeGeneration"] = "old"
			}
			if kind == "stale-source" {
				row["recoverySnapshot"] = M{"_id": repo["_id"], "source.commit": "retired"}
			}
			if _, err := s.Store.DB.Collection("files").InsertOne(ctx, row); err != nil {
				t.Fatal(err)
			}
		}
		// A stale provenance row reports a conflict, but must not stop other repairs.
		if err := s.repairPendingMetadata(ctx); err == nil || err.Error() != "repository_changed" {
			t.Fatal(err)
		}
		for _, kind := range []string{"ready", "legacy", "missing", "generation", "expired", "removing", "archived", "stale-source"} {
			id := prefix + "-" + kind
			row, err := s.Store.one(ctx, "files", M{"repoId": id})
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "ready", "legacy", "archived":
				if row == nil || boolean(row["metadataPending"]) {
					t.Fatal(kind, row)
				}
				repo, err := s.Store.one(ctx, collection("repo"), M{"repoId": id})
				if err != nil || repo["fileMetadataRevision"] == "before" {
					t.Fatal(kind, repo, err)
				}
				if kind == "archived" {
					if row, err := s.indexedFile(ctx, repo, "file.txt"); err == nil || row != nil {
						t.Fatal("archived content lookup allowed", row, err)
					}
				}
			default:
				if row != nil {
					t.Fatal(kind, "retired row retained", row)
				}
			}
		}
		// A completed row remains even if a stale maintenance cursor saw it pending.
		row, err := s.Store.one(ctx, "files", M{"repoId": prefix + "-ready"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": prefix + "-ready"}); err != nil {
			t.Fatal(err)
		}
		if err = s.repairPendingFile(ctx, row); err != nil {
			t.Fatal(err)
		}
		if count, err := s.Store.DB.Collection("files").CountDocuments(ctx, M{"_id": row["_id"]}); err != nil || count != 1 {
			t.Fatal(count, err)
		}
	})
}
