package server

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func defaults(value M, fields M) {
	for key, fallback := range fields {
		if _, present := value[key]; !present {
			value[key] = fallback
		}
	}
}
func omitEmptyObject(value M, key string) {
	if field, present := value[key]; present && field != nil {
		switch field.(type) {
		case M, map[string]any, bson.D:
			if len(obj(field)) == 0 {
				delete(value, key)
			}
		}
	}
}
func adminUserJSON(user M, repositories []M, now time.Time) M {
	// Explicit public metadata prevents legacy token fields and credential
	// envelopes from becoming part of this administrator response.
	out := selectFields(user, "_id", "__v", "username", "photo", "status", "isAdmin", "emails", "dateOfEntry", "externalIDs", "accessTokenDates", "projectNames", "default", "notificationEmail", "emailPromptNever")
	defaults(out, M{"emailPromptNever": false, "isAdmin": false, "status": "active", "dateOfEntry": now, "emails": []any{}})
	for _, key := range []string{"externalIDs", "accessTokenDates"} {
		omitEmptyObject(out, key)
	}
	if value, present := out["default"]; !present || value != nil {
		value := selectFields(obj(value), "terms", "options")
		defaults(value, M{"terms": []any{}})
		omitEmptyObject(value, "options")
		out["default"] = value
	}
	indexed := map[string]M{}
	for _, repository := range repositories {
		value := selectFields(repository, "_id", "__v", "externalId", "name", "url", "source", "provider", "providerRepositoryId", "hasPage", "pageSource", "branches", "defaultBranch", "size", "status", "dateOfEntry")
		defaults(value, M{"source": "github", "hasPage": false, "status": "ready", "dateOfEntry": now, "branches": []any{}})
		omitEmptyObject(value, "pageSource")
		indexed[str(repository["_id"])] = value
	}
	populated := []M{}
	for _, id := range arr(user["repositories"]) {
		if repository := indexed[str(id)]; repository != nil {
			populated = append(populated, repository)
		}
	}
	out["repositories"] = populated
	if value, present := user["repositories"]; present && value == nil {
		out["repositories"] = nil
	}
	return out
}
func (s *Server) adminUserDetail(ctx context.Context, user M) (M, error) {
	ids := []bson.ObjectID{}
	for _, value := range arr(user["repositories"]) {
		if id, err := oid(str(value)); err == nil {
			ids = append(ids, id)
		}
	}
	repositories := []M{}
	if len(ids) > 0 {
		var err error
		repositories, err = s.Store.list(ctx, "repositories", M{"_id": M{"$in": ids}}, int64(len(ids)), nil)
		if err != nil {
			return nil, err
		}
	}
	return adminUserJSON(user, repositories, time.Now().Truncate(time.Millisecond)), nil
}
