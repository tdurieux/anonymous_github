package server

import (
	"context"
	"errors"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Replay only recorded transitions. Inferring changes from current repository
// status would rewrite TypeScript billing history after expiry or removal.
func (s *Server) reconcileConference(ctx context.Context, c M) (M, error) {
	if err := s.replayConferenceMemberships(ctx, str(c["conferenceID"])); err != nil {
		return nil, err
	}
	return s.Store.one(ctx, "conferences", M{"_id": c["_id"]})
}

// Find pending transitions in bounded batches before listing conferences. Most
// listings need no per-conference replay or reload; affected histories still use
// the existing revision-guarded reconciliation path.
func (s *Server) pendingConferences(ctx context.Context, conferences []M) (map[string]bool, error) {
	affected := map[string]bool{}
	ids := []string{}
	bytes := 0
	scan := func() error {
		if len(ids) == 0 {
			return nil
		}
		filter := M{"conferenceMembership.id": M{"$exists": true}, "$or": []M{{"conferenceMembership.from": M{"$in": ids}}, {"conferenceMembership.to": M{"$in": ids}}}}
		cursor, err := s.Store.DB.Collection(collection("repo")).Find(ctx, filter, options.Find().SetProjection(M{"_id": 0, "conferenceMembership.from": 1, "conferenceMembership.to": 1}))
		if err != nil {
			return err
		}
		defer cursor.Close(ctx)
		for cursor.Next(ctx) {
			var row M
			if err := cursor.Decode(&row); err != nil {
				return err
			}
			event := obj(row["conferenceMembership"])
			affected[str(event["from"])] = true
			affected[str(event["to"])] = true
		}
		return cursor.Err()
	}
	for _, conference := range conferences {
		id := str(conference["conferenceID"])
		if len(ids) > 0 && (len(ids) >= 500 || bytes+len(id) > 1024*1024) {
			if err := scan(); err != nil {
				return nil, err
			}
			ids = nil
			bytes = 0
		}
		ids = append(ids, id)
		bytes += len(id)
	}
	if err := scan(); err != nil {
		return nil, err
	}
	return affected, nil
}

func (s *Server) replayConferenceMemberships(ctx context.Context, conferenceID string) error {
	filter := M{"conferenceMembership.id": M{"$exists": true}}
	if conferenceID != "" {
		filter["$or"] = []M{{"conferenceMembership.from": conferenceID}, {"conferenceMembership.to": conferenceID}}
	}
	rows, err := s.Store.list(ctx, collection("repo"), filter, 1000, nil)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if err := s.flushConferenceMembership(ctx, r); err != nil {
			return err
		}
	}
	if len(rows) == 1000 {
		return fail("conference_replay_pending", 503)
	}
	return nil
}

func (s *Server) flushConferenceMembership(ctx context.Context, r M) error {
	event := obj(r["conferenceMembership"])
	if len(event) == 0 {
		return nil
	}
	at, valid := storedDate(event["at"])
	if !valid || event["id"] == nil {
		return fail("invalid_conference_transition", 500)
	}
	if err := s.saveConferenceMembership(ctx, r["_id"], str(event["from"]), str(event["to"]), at); err != nil {
		return err
	}
	_, err := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"], "conferenceMembership.id": event["id"]}, M{"$unset": M{"conferenceMembership": ""}})
	if err == nil {
		delete(r, "conferenceMembership")
	}
	return err
}

func membershipSaveFilter(kind string, previous M) M {
	filter := revisionFilter(previous)
	if kind == "repo" {
		filter["conferenceMembership"] = M{"$exists": false}
	}
	return filter
}

func membershipSaveTime(previous M) time.Time {
	now := time.Now().Truncate(time.Millisecond)
	if previous != nil && !now.After(date(previous["settingsSavedAt"])) {
		now = date(previous["settingsSavedAt"]).Add(time.Millisecond)
	}
	return now
}

func recordConferenceMembership(record M, from, to string, at time.Time) {
	if from != to {
		record["conferenceMembership"] = M{"id": bson.NewObjectID(), "from": from, "to": to, "at": at}
	}
}

// Record membership at save time. Rejoining resets the first matching interval,
// matching the TypeScript route's existing history format.
func (s *Server) saveConferenceMembership(ctx context.Context, repositoryID any, from, to string, at time.Time) error {
	if from == to {
		return nil
	}
	change := func(id string, joining bool) error {
		if id == "" {
			return nil
		}
		for attempt := 0; attempt < 3; attempt++ {
			var snapshot struct {
				ID           bson.ObjectID `bson:"_id"`
				Repositories []bson.D      `bson:"repositories"`
			}
			err := s.Store.DB.Collection("conferences").FindOne(ctx, M{"conferenceID": id}).Decode(&snapshot)
			if errors.Is(err, mongo.ErrNoDocuments) {
				return nil
			}
			if err != nil {
				return err
			}
			original := make([]any, len(snapshot.Repositories))
			history := make([]any, len(snapshot.Repositories))
			matches := []int{}
			for i, entry := range snapshot.Repositories {
				original[i] = entry
				copy := obj(entry)
				history[i] = copy
				if str(copy["id"]) == str(repositoryID) {
					matches = append(matches, i)
				}
			}
			// A delayed replay must not undo a later transition. Save timestamps
			// increase by at least one millisecond for each repository revision.
			for _, i := range matches {
				entry := obj(history[i])
				if date(entry["addDate"]).After(at) || date(entry["removeDate"]).After(at) {
					return nil
				}
			}
			if joining {
				if len(matches) == 0 {
					history = append(history, M{"id": repositoryID, "addDate": at})
				} else {
					entry := obj(history[matches[0]])
					entry["addDate"] = at
					delete(entry, "removeDate")
				}
			} else {
				if len(matches) != 1 {
					return nil
				}
				obj(history[matches[0]])["removeDate"] = at
			}
			ok, err := s.Store.update(ctx, "conferences", M{"_id": snapshot.ID, "repositories": original}, M{"$set": M{"repositories": history}})
			if err != nil {
				return err
			}
			if ok {
				return nil
			}
		}
		return fail("conference_changed", 409)
	}
	if err := change(to, true); err != nil {
		return err
	}
	return change(from, false)
}
