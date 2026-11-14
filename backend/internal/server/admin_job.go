package server

import "time"

// Job IDs are opaque to callers. Preserve the stored resource kind and action,
// including document preparation and expiry jobs in the remove queue.
func (s *Server) adminJob(q *request, id string, actions []string) (any, error) {
	filter := M{"_id": id, "action": M{"$in": actions}}
	if q.R.Method == "DELETE" {
		result, err := s.Store.DB.Collection("gojobs").DeleteOne(q.ctx(), filter)
		if err != nil {
			return nil, err
		}
		if result.DeletedCount == 0 {
			return nil, fail("job_not_found", 404)
		}
		// As with BullMQ removal, this removes the queue record, not work already
		// running. The old worker's lease cannot update a replacement record.
		return M{"ok": true}, nil
	}
	job, err := s.Store.one(q.ctx(), "gojobs", filter)
	if err != nil {
		return nil, err
	}
	if job == nil {
		return nil, fail("job_not_found", 404)
	}
	if job["state"] == "active" {
		return nil, fail("job_is_active", 409)
	}
	if job["action"] == "prepare" {
		kind := str(job["kind"])
		if collection(kind) == "" {
			return nil, fail("invalid_job", 400)
		}
		resource := resourceFilter(kind, str(job["resourceId"]))
		resource["status"] = "error"
		if _, err := s.Store.update(q.ctx(), collection(kind), resource, M{"$set": M{"status": "preparing", "statusDate": time.Now()}}); err != nil {
			return nil, err
		}
	}
	filter["state"] = M{"$ne": "active"}
	changed, err := s.Store.update(q.ctx(), "gojobs", filter, M{
		"$set":   M{"state": "waiting", "attempts": 0, "availableAt": time.Now()},
		"$unset": M{"lease": "", "leaseUntil": "", "finishedAt": "", "error": ""},
	})
	if err != nil {
		return nil, err
	}
	if !changed {
		delete(filter, "state")
		current, err := s.Store.one(q.ctx(), "gojobs", filter)
		if err != nil {
			return nil, err
		}
		if current == nil {
			return nil, fail("job_not_found", 404)
		}
		return nil, fail("job_is_active", 409)
	}
	return M{"ok": true}, nil
}
