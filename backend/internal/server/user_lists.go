package server

import (
	"context"
	"time"
)

func repositoryMembership(user M) M {
	clauses := []M{{"owner": user["_id"]}}
	if id := str(obj(user["externalIDs"])["github"]); id != "" {
		clauses = append(clauses, M{"coauthors.githubId": id})
	}
	if username := str(user["username"]); username != "" {
		clauses = append(clauses, M{"coauthors": M{"$elemMatch": M{"username": username, "$or": []M{{"githubId": M{"$exists": false}}, {"githubId": nil}, {"githubId": ""}}}}})
	}
	return M{"$or": clauses}
}

// Lists mark only overdue ready resources, then reload affected rows so a
// concurrent extension, removal or deletion is reflected in the response.
func (s *Server) markListExpired(ctx context.Context, kind string, rows []M) ([]M, error) {
	now := time.Now().Truncate(time.Millisecond)
	ids := []any{}
	affected := map[string]bool{}
	for _, row := range rows {
		options := obj(row["options"])
		expires := date(options["expirationDate"])
		if str(row["status"]) == "ready" && str(options["expirationMode"]) != "never" && inputTruthy(options["expirationDate"]) && !expires.After(now) {
			ids = append(ids, row["_id"])
			affected[str(row["_id"])] = true
		}
	}
	if len(ids) == 0 {
		return rows, nil
	}
	_, err := s.Store.DB.Collection(collection(kind)).UpdateMany(ctx, M{"_id": M{"$in": ids}, "status": "ready", "options.expirationMode": M{"$ne": "never"}, "options.expirationDate": M{"$lte": now}}, M{"$set": M{"status": "expiring", "statusDate": now}})
	if err != nil {
		return nil, err
	}
	fresh, err := s.Store.list(ctx, collection(kind), M{"_id": M{"$in": ids}}, int64(len(ids)), nil)
	if err != nil {
		return nil, err
	}
	current := map[string]M{}
	for _, row := range fresh {
		current[str(row["_id"])] = row
	}
	out := []M{}
	for _, row := range rows {
		id := str(row["_id"])
		if !affected[id] {
			out = append(out, row)
		} else if value := current[id]; value != nil {
			out = append(out, value)
		}
	}
	return out, nil
}
