package server

import (
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// The legacy user map remains authoritative so rollback retains private labels.
func (s *Server) ensureDashboardNames(q *request) error {
	return s.dashboardNames.run(q.ctx(), str(q.User["_id"]), func() error { return s.reconcileDashboardNames(q) })
}
func (s *Server) reconcileDashboardNames(q *request) error {
	names := obj(q.User["projectNames"])
	// Stream both existing names and artifact IDs. Neither collection has a
	// correctness cap, and full artifact bodies are never loaded for backfill.
	reconcile := func(collection string, filter, projection M, change func(M) mongo.WriteModel) error {
		cursor, err := s.Store.DB.Collection(collection).Find(q.ctx(), filter, options.Find().SetProjection(projection).SetBatchSize(250))
		if err != nil {
			return err
		}
		defer cursor.Close(q.ctx())
		batch := make([]mongo.WriteModel, 0, 250)
		flush := func() error {
			if len(batch) == 0 {
				return nil
			}
			_, err := s.Store.DB.Collection("dashboardnames").BulkWrite(q.ctx(), batch)
			batch = batch[:0]
			return err
		}
		for cursor.Next(q.ctx()) {
			var row M
			if err := cursor.Decode(&row); err != nil {
				return err
			}
			if operation := change(row); operation != nil {
				batch = append(batch, operation)
			}
			if len(batch) == 250 {
				if err := flush(); err != nil {
					return err
				}
			}
		}
		if err := cursor.Err(); err != nil {
			return err
		}
		return flush()
	}
	if err := reconcile("dashboardnames", M{"owner": q.User["_id"]}, M{"type": 1, "artifactId": 1}, func(row M) mongo.WriteModel {
		name := str(names[projectNameKey(str(row["type"]), str(row["artifactId"]))])
		if name == "" {
			return mongo.NewDeleteOneModel().SetFilter(M{"_id": row["_id"]})
		}
		return mongo.NewUpdateOneModel().SetFilter(M{"_id": row["_id"]}).SetUpdate(M{"$set": M{"name": name}})
	}); err != nil {
		return err
	}
	if len(names) == 0 {
		return nil
	}
	for _, kind := range []string{"repo", "pr", "gist"} {
		if err := reconcile(collection(kind), membership(q, kind), M{idKey(kind): 1}, func(row M) mongo.WriteModel {
			id := str(row[idKey(kind)])
			name := str(names[projectNameKey(kind, id)])
			if name == "" {
				return nil
			}
			return mongo.NewUpdateOneModel().SetFilter(M{"owner": q.User["_id"], "type": kind, "artifactId": id}).SetUpdate(M{"$set": M{"name": name}}).SetUpsert(true)
		}); err != nil {
			return err
		}
	}
	return nil
}
