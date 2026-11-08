package server

import (
	"context"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runFileRecoveryIntegration(t *testing.T, s *Server, p *fixtureProvider) {
	t.Run("truncated file recovery", func(t *testing.T) {
		ctx := t.Context()
		original, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil || original == nil {
			t.Fatal(err)
		}
		repo := selectFields(original, "owner", "source", "providerAccess")
		id := "recovery-" + bson.NewObjectID().Hex()
		repo["_id"], repo["repoId"], repo["status"], repo["treeGeneration"] = bson.NewObjectID(), id, "ready", "fixture"
		repo["options"] = M{"terms": []string{"private => hidden"}}
		repo["truncatedFolders"] = []string{"docs"}
		if _, err = s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
			t.Fatal(err)
		}
		defer s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": id})
		defer s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": id})
		old := p.onMetadata
		defer func() { p.onMetadata = old; p.revoked = false }()
		calls := 0
		p.onMetadata = func(_ context.Context, a provider.Access, requested string) (*provider.Entry, error) {
			calls++
			if a.Ref.Provider != "fixture" || a.Ref.Commit != str(obj(repo["source"])["commit"]) {
				t.Fatal(a.Ref)
			}
			return &provider.Entry{Path: requested, Revision: "opaque:recovered", Size: 17}, nil
		}
		for _, requested := range []string{"outside.txt", "docs-other/file.txt", "docs/private.txt"} {
			if _, err := s.indexedFile(ctx, repo, requested); err == nil {
				t.Fatal(requested, "unexpected recovery")
			}
		}
		if calls != 0 {
			t.Fatal("unexpected upstream lookup", calls)
		}
		row, err := s.indexedFile(ctx, repo, "docs/missing.txt")
		if err != nil || row["sha"] != "opaque:recovered" || repo["fileMetadataRevision"] == nil {
			t.Fatal(row, err)
		}
		if calls != 1 {
			t.Fatal(calls)
		}
		cached, err := s.Store.one(ctx, "files", M{"repoId": id, "name": "missing.txt"})
		if err != nil || cached == nil || boolean(cached["metadataPending"]) {
			t.Fatal(cached, err)
		}
		if _, err = s.indexedFile(ctx, repo, "docs/missing.txt"); err != nil || calls != 1 {
			t.Fatal(calls, err)
		}
		p.revoked = true
		if _, err = s.indexedFile(ctx, repo, "docs/denied.txt"); err == nil || calls != 1 {
			t.Fatal("revocation bypass", calls, err)
		}
		p.revoked = false
		// A pending row from an interrupted recovery finishes invalidation on retry.
		cached["metadataPending"] = true
		if _, err = s.Store.DB.Collection("files").UpdateOne(ctx, M{"_id": cached["_id"]}, M{"$set": M{"metadataPending": true}}); err != nil {
			t.Fatal(err)
		}
		previous := repo["fileMetadataRevision"]
		if _, err = s.indexedFile(ctx, repo, "docs/missing.txt"); err != nil || repo["fileMetadataRevision"] == previous {
			t.Fatal(err)
		}

		before := calls
		if original, err := s.originalFolder(ctx, repo, "docs/listed-file.txt"); err != nil || original != "docs/listed-file.txt" || calls != before+1 {
			t.Fatal(original, err, calls)
		}
		before = calls
		if _, err := s.originalFolder(ctx, repo, "../unsafe"); err == nil || calls != before {
			t.Fatal("unsafe folder recovery", calls, err)
		}
		// A persisted pending row belongs to its original commit/settings.
		snapshot := pathSnapshotFilter(repo)
		delete(snapshot, "fileMetadataRevision")
		pending := M{"_id": bson.NewObjectID(), "repoId": id, "treeGeneration": "fixture", "path": "docs", "name": "old.txt", "sha": "old-commit", "size": 1, "metadataPending": true, "recoverySnapshot": snapshot}
		if _, err = s.Store.DB.Collection("files").InsertOne(ctx, pending); err != nil {
			t.Fatal(err)
		}
		if _, err = s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": M{"source.commit": "new-commit"}}); err != nil {
			t.Fatal(err)
		}
		repo["source"] = selectFields(obj(repo["source"]), "provider", "providerRepositoryId", "repositoryName", "branch")
		obj(repo["source"])["commit"] = "new-commit"
		if _, err = s.indexedFile(ctx, repo, "docs/old.txt"); err == nil || err.Error() != "repository_changed" {
			t.Fatal("stale pending row accepted", err)
		}
		if count, err := s.Store.DB.Collection("files").CountDocuments(ctx, M{"_id": pending["_id"]}); err != nil || count != 0 {
			t.Fatal("stale pending row retained", count, err)
		}
		// A concurrent repository change prevents persistence after the upstream call.
		p.onMetadata = func(_ context.Context, a provider.Access, requested string) (*provider.Entry, error) {
			_, err := s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": M{"status": "archived"}})
			if err != nil {
				t.Fatal(err)
			}
			return &provider.Entry{Path: requested, Revision: "opaque:new", Size: 1}, nil
		}
		if _, err = s.indexedFile(ctx, repo, "docs/stale.txt"); err == nil || err.Error() != "repository_changed" {
			t.Fatal(err)
		}
		if count, err := s.Store.DB.Collection("files").CountDocuments(ctx, M{"repoId": id, "name": "stale.txt"}); err != nil || count != 0 {
			t.Fatal(count, err)
		}
	})
}
