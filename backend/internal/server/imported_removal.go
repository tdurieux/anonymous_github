package server

import (
	"context"
	"go.mongodb.org/mongo-driver/v2/bson"
	"time"
)

// Resume legacy failed removals at startup, or once for newly imported jobs.
// A paused startup pass remains pending until the queue resumes. Eligibility
// is checked by runJob immediately before cleanup, not at enqueue time.
func (s *Server) recoverImportedRemovalJobs(ctx context.Context) error {
	paused, err := s.Store.Redis.Exists(ctx, "go:pause:remove").Result()
	if err != nil || paused != 0 {
		return err
	}
	filter := M{
		"kind": "repo", "action": "remove", "state": "failed",
		"migration.version": 1, "migration.sourceQueue": "repository removal",
	}
	if !s.removalRecoveryPending.Load() {
		filter["migration.removalRecovered"] = M{"$ne": true}
	}
	_, err = s.Store.DB.Collection("gojobs").UpdateMany(ctx, filter, M{
		"$set":   M{"state": "waiting", "attempts": 0, "availableAt": time.Now(), "migration.removalRecovered": true},
		"$unset": M{"error": "", "finishedAt": "", "lease": "", "leaseUntil": ""},
	})
	if err == nil {
		s.removalRecoveryPending.Store(false)
	}
	return err
}

// BullMQ marks exhausted removals as ERROR, unlike Go's persistent REMOVING
// state. Recover only imported removal requests that are still current. These
// eligibility rules match TypeScript recoverStuckRemoving.
func (s *Server) recoverImportedRemoval(ctx context.Context, job, resource M) (M, error) {
	imported := obj(job["migration"])
	if str(job["kind"]) != "repo" || str(job["action"]) != "remove" || number(imported["version"]) != 1 || str(imported["sourceQueue"]) != "repository removal" || str(resource["status"]) == "removed" {
		return nil, nil
	}
	conditions := []M{}
	var created time.Time
	switch value := job["createdAt"].(type) {
	case time.Time:
		created = value
	case bson.DateTime:
		created = value.Time()
	}
	if !created.IsZero() && created.UnixMilli() > 0 {
		conditions = append(conditions, M{"status": "error", "$or": []M{{"anonymizeDate": M{"$lte": created}}, {"anonymizeDate": M{"$exists": false}}}})
	}
	if resource["owner"] != nil {
		owner, err := s.Store.one(ctx, "users", M{"_id": resource["owner"], "status": "banned"})
		if err != nil {
			return nil, err
		}
		if owner != nil {
			conditions = append(conditions, M{"owner": resource["owner"], "status": M{"$ne": "removed"}})
		}
	}
	if len(conditions) == 0 {
		return nil, nil
	}
	filter := revisionFilter(resource)
	filter["$or"] = conditions
	for _, field := range []string{"owner", "anonymizeDate"} {
		if value, exists := resource[field]; exists {
			filter[field] = value
		} else {
			filter[field] = M{"$exists": false}
		}
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	changed, err := s.Store.update(ctx, collection("repo"), filter, M{"$set": M{"status": "removing", "statusDate": now}, "$unset": M{"statusMessage": ""}})
	if err != nil || !changed {
		return nil, err
	}
	// Preserve the exact claimed revision for the worker's final publication.
	claimed := M{}
	for key, value := range resource {
		claimed[key] = value
	}
	claimed["status"], claimed["statusDate"] = "removing", now
	delete(claimed, "statusMessage")
	return claimed, nil
}
