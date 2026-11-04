package server

import (
	"context"
	"errors"

	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Removal takes a snapshot before checking the resource revision. A duplicate
// worker may finish after restoration, so deletion must never rescan a prefix
// or delete every row belonging to the repository.
type removalSnapshot struct {
	content []string
	rows    map[string][]any
}

func (s *Server) snapshotRemoval(ctx context.Context, r M) (*removalSnapshot, error) {
	id := str(r["repoId"])
	entries, err := s.content.List(ctx, id)
	if err != nil {
		return nil, err
	}
	snapshot := &removalSnapshot{rows: map[string][]any{}}
	for _, entry := range entries {
		snapshot.content = append(snapshot.content, entry.Path)
	}
	for _, name := range []string{"files", "anonymizedpaths"} {
		cursor, err := s.Store.DB.Collection(name).Find(ctx, M{"repoId": id}, options.Find().SetProjection(M{"_id": 1}))
		if err != nil {
			return nil, err
		}
		for cursor.Next(ctx) {
			var row M
			if err = cursor.Decode(&row); err != nil {
				break
			}
			if len(snapshot.rows[name]) >= 1000000 {
				err = errors.New("removal_snapshot_too_large")
				break
			}
			snapshot.rows[name] = append(snapshot.rows[name], row["_id"])
		}
		if err == nil {
			err = cursor.Err()
		}
		cursor.Close(ctx)
		if err != nil {
			return nil, err
		}
	}
	// Reading after the snapshots also rejects snapshots that overlap a restore.
	current, err := s.Store.one(ctx, collection("repo"), revisionFilter(r))
	if err != nil || current == nil {
		return nil, err
	}
	return snapshot, nil
}

func (s *Server) deleteRemovalSnapshot(ctx context.Context, id string, snapshot *removalSnapshot) error {
	// Go publishes remote content under immutable generation paths. Archive
	// originals are read-only. New content cannot reuse a captured object name.
	if err := s.content.RemoveFiles(ctx, id, snapshot.content); err != nil {
		return err
	}
	for _, name := range []string{"files", "anonymizedpaths"} {
		ids := snapshot.rows[name]
		for len(ids) > 0 {
			n := min(len(ids), 1000)
			if _, err := s.Store.DB.Collection(name).DeleteMany(ctx, M{"repoId": id, "_id": M{"$in": ids[:n]}}); err != nil {
				return err
			}
			ids = ids[n:]
		}
	}
	return nil
}
