package server

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Conference membership is recorded as intervals. Only open intervals take
// part in a conference-wide lifecycle change; closed intervals are billing history.
func conferenceRepositoryIDs(c M) []bson.ObjectID {
	ids := []bson.ObjectID{}
	for _, value := range arr(c["repositories"]) {
		entry := obj(value)
		// A BSON Date at year 0001 or the Unix epoch is still a closed interval.
		if inputTruthy(entry["removeDate"]) {
			continue
		}
		if id, err := oid(str(entry["id"])); err == nil {
			ids = append(ids, id)
		}
	}
	return ids
}

func (s *Server) expireConference(ctx context.Context, c M) error {
	if str(c["status"]) != "ready" || !date(c["endDate"]).Before(time.Now()) {
		return nil
	}
	// Match Repository.markExpired(true): an already inactive repository keeps
	// its status and timestamp, even when its own expiration mode is "never".
	_, err := s.Store.DB.Collection(collection("repo")).UpdateMany(ctx,
		M{"_id": M{"$in": conferenceRepositoryIDs(c)}, "status": M{"$nin": []string{"archived", "removed", "removing", "expired", "expiring"}}},
		M{"$set": M{"status": "expiring", "statusDate": time.Now()}})
	if err != nil {
		return err
	}
	ok, err := s.Store.update(ctx, "conferences", M{"_id": c["_id"], "status": "ready", "endDate": c["endDate"]}, M{"$set": M{"status": "expired"}})
	if err != nil {
		return err
	}
	if !ok {
		return fail("conference_changed", 409)
	}
	c["status"] = "expired"
	return nil
}

// The conference route waits for cleanup and attempts every member even if one
// fails. The removed conference and any unfinished removing repositories remain
// durable so maintenance or a repeated request can finish interrupted work.
func (s *Server) removeConference(ctx context.Context, c M) error {
	ok, err := s.Store.update(ctx, "conferences", M{"_id": c["_id"], "status": c["status"]}, M{"$set": M{"status": "removed"}})
	if err != nil {
		return err
	}
	if !ok {
		return fail("conference_changed", 409)
	}
	c["status"] = "removed"
	rows, err := s.Store.list(ctx, collection("repo"), M{"_id": M{"$in": conferenceRepositoryIDs(c)}}, 0, nil)
	if err != nil {
		return err
	}
	failed := false
	for _, r := range rows {
		if str(r["status"]) == "archived" {
			failed = true
			continue
		}
		claimed, err := s.Store.update(ctx, collection("repo"), revisionFilter(r), M{"$set": M{"status": "removing", "statusDate": time.Now()}})
		if err != nil || !claimed {
			failed = true
			continue
		}
		if err := s.runJob(ctx, M{"kind": "repo", "resourceId": r["repoId"], "action": "remove"}); err != nil {
			failed = true
			continue
		}
		current, err := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if err != nil || current == nil || str(current["status"]) != "removed" {
			failed = true
		}
	}
	if failed {
		return errors.New("conference_repository_removal_failed")
	}
	return nil
}
