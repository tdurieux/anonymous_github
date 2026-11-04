package server

import (
	"context"
	"path"
	"strings"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func (s *Server) recoverTruncatedFile(ctx context.Context, r M, requested string) (M, error) {
	if normalized, err := security.RelativePath(requested); err != nil || normalized != requested {
		return nil, fail("file_not_found", 404)
	}
	directory := path.Dir(requested)
	if directory == "." {
		directory = ""
	}
	affected := false
	for _, folder := range stringsOf(r["truncatedFolders"]) {
		if folder == "" || folder == directory || strings.HasPrefix(directory, folder+"/") {
			affected = true
			break
		}
	}
	if !affected {
		return nil, fail("file_not_found", 404)
	}
	engine, err := s.engine(r, "repo")
	if err != nil {
		return nil, err
	}
	transformed, err := engine.Path(ctx, requested)
	if err != nil {
		return nil, err
	}
	if transformed != requested {
		return nil, fail("file_not_found", 404)
	}
	p, a, err := s.repositoryProvider(r)
	if err != nil {
		return nil, err
	}
	metadata, ok := p.(provider.FileMetadata)
	if !ok {
		return nil, fail("file_not_found", 404)
	}
	if err = s.authorizeMeasured(ctx, p, a); err != nil {
		return nil, err
	}
	entry, err := metadata.FileMetadata(ctx, a, requested)
	if err != nil {
		return nil, providerFailure(err)
	}
	if entry == nil || entry.Directory {
		return nil, fail("file_not_found", 404)
	}
	if entry.Path != requested || entry.Revision == "" || entry.Size < 0 {
		return nil, fail("invalid_file_metadata", 502)
	}
	if err = s.authorizeMeasured(ctx, p, a); err != nil {
		return nil, err
	}
	if err = s.checkPathSnapshot(ctx, r); err != nil {
		return nil, err
	}
	row := M{"_id": bson.NewObjectID(), "repoId": r["repoId"], "path": directory, "name": path.Base(requested), "sha": entry.Revision, "size": entry.Size, "metadataPending": true}
	if generation, ok := r["treeGeneration"]; ok {
		row["treeGeneration"] = generation
	}
	snapshot := pathSnapshotFilter(r)
	delete(snapshot, "fileMetadataRevision")
	row["recoverySnapshot"] = snapshot
	if _, err = s.Store.DB.Collection("files").InsertOne(ctx, row); err != nil {
		return nil, err
	}
	if err = s.completeRecoveredMetadata(ctx, r, row); err != nil {
		return nil, err
	}
	return row, nil
}

func (s *Server) completeRecoveredMetadata(ctx context.Context, r, row M) error {
	return s.completeRecoveredMetadataState(ctx, r, row, false)
}
func (s *Server) completeRecoveredMetadataState(ctx context.Context, r, row M, maintenance bool) error {
	if !boolean(row["metadataPending"]) {
		return nil
	}
	if snapshot := obj(row["recoverySnapshot"]); len(snapshot) > 0 {
		current, err := s.Store.one(ctx, collection("repo"), snapshot)
		if err != nil {
			return err
		}
		if current == nil {
			if _, err := s.Store.DB.Collection("files").DeleteOne(ctx, M{"_id": row["_id"], "metadataPending": true}); err != nil {
				return err
			}
			return fail("repository_changed", 409)
		}
	}
	if err := s.checkPathSnapshotStatus(ctx, r, maintenance); err != nil {
		return err
	}
	revision, err := security.RandomToken()
	if err != nil {
		return err
	}
	filter := pathSnapshotFilter(r)
	updated, err := s.Store.update(ctx, collection("repo"), filter, M{"$set": M{"fileMetadataRevision": revision, "size": M{"storage": 0, "file": 0}}, "$unset": M{"pathIndexKey": "", "pathIndexBuiltAt": "", "sizeComputedAt": ""}})
	if err != nil {
		return err
	}
	if !updated {
		return fail("repository_changed", 409)
	}
	r["fileMetadataRevision"] = revision
	if _, err = s.Store.DB.Collection("files").UpdateOne(ctx, M{"_id": row["_id"]}, M{"$unset": M{"metadataPending": "", "recoverySnapshot": ""}}); err != nil {
		return err
	}
	delete(row, "metadataPending")
	delete(row, "recoverySnapshot")
	return nil
}
