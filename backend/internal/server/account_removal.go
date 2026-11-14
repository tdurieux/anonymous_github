package server

import "time"

// Account deletion waits for each owned resource, in TypeScript's repo/PR/gist
// order. A failed cleanup leaves the account usable for a retry; completed
// tombstones stay reserved and are skipped on subsequent requests.
func (s *Server) removeAccountResources(q *request) error {
	for _, kind := range []string{"repo", "pr", "gist"} {
		rows, err := s.Store.list(q.ctx(), collection(kind), membership(q, kind), 0, nil)
		if err != nil {
			return err
		}
		rows, err = s.markListExpired(q.ctx(), kind, rows)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if str(row["owner"]) != str(q.User["_id"]) || str(row["status"]) == "removed" {
				continue
			}
			if kind == "repo" && str(row["status"]) == "archived" {
				return fail("repository_archived", 410)
			}
			claimed, err := s.Store.update(q.ctx(), collection(kind), revisionFilter(row), M{"$set": M{"status": "removing", "statusDate": time.Now()}})
			if err != nil {
				return err
			}
			if !claimed {
				return fail("repository_changed", 409)
			}
			if err := s.runJob(q.ctx(), M{"kind": kind, "resourceId": row[idKey(kind)], "action": "remove"}); err != nil {
				return err
			}
			current, err := s.Store.one(q.ctx(), collection(kind), M{"_id": row["_id"]})
			if err != nil {
				return err
			}
			if current == nil || str(current["status"]) != "removed" {
				return fail("repository_changed", 409)
			}
		}
	}
	return nil
}
