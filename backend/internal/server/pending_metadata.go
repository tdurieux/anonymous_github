package server

import (
	"context"
	"reflect"

	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// repairPendingMetadata streams all pending rows, so idle repositories recover
// after interrupted invalidation without waiting for another file request.
func (s *Server) repairPendingMetadata(ctx context.Context) error {
	cursor, err := s.Store.DB.Collection("files").Find(ctx, M{"metadataPending": true}, options.Find().SetBatchSize(128))
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)
	var first error
	for cursor.Next(ctx) {
		var row M
		if err := cursor.Decode(&row); err != nil {
			return err
		}
		if err := s.repairPendingFile(ctx, row); err != nil && first == nil {
			first = err
		}
	}
	if err := cursor.Err(); err != nil {
		return err
	}
	return first
}

func (s *Server) repairPendingFile(ctx context.Context, row M) error {
	repo, err := s.Store.one(ctx, collection("repo"), M{"repoId": row["repoId"]})
	if err != nil {
		return err
	}
	retired := repo == nil || !reflect.DeepEqual(repo["treeGeneration"], row["treeGeneration"])
	switch str(repo["status"]) {
	case "expiring", "expired", "removing", "removed":
		retired = true
	}
	if retired {
		_, err := s.Store.DB.Collection("files").DeleteOne(ctx, M{"_id": row["_id"], "metadataPending": true})
		return err
	}
	return s.completeRecoveredMetadataState(ctx, repo, row, true)
}
