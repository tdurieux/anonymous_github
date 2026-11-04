package server

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func (s *Server) retryFailedJobs(ctx context.Context, actions ...string) (M, error) {
	cursor, err := s.Store.DB.Collection("gojobs").Find(ctx, M{"action": M{"$in": actions}, "state": "failed"}, options.Find().SetProjection(M{"_id": 1, "kind": 1, "resourceId": 1, "action": 1}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	// Capture the selected jobs before making writes. A job failing later must
	// not be swept into a bulk state change without preparing its resource.
	jobs := []M{}
	if err := cursor.All(ctx, &jobs); err != nil {
		return nil, err
	}
	retried := int64(0)
	for _, job := range jobs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		action := str(job["action"])
		if action == "prepare" {
			kind := str(job["kind"])
			if collection(kind) == "" {
				continue
			}
			filter := resourceFilter(kind, str(job["resourceId"]))
			filter["status"] = "error"
			if _, err := s.Store.update(ctx, collection(kind), filter, M{"$set": M{"status": "preparing", "statusDate": time.Now()}}); err != nil {
				continue
			}
		}
		changed, err := s.Store.update(ctx, "gojobs", M{"_id": job["_id"], "action": action, "state": "failed"}, M{"$set": M{"state": "waiting", "attempts": 0, "availableAt": time.Now()}})
		if err == nil && changed {
			retried++
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return M{"retried": retried, "total": int64(len(jobs))}, nil
}
