package server

import (
	"errors"
	"strings"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Preserve the original BSON array for the compare-and-swap predicate: MongoDB
// compares embedded document field order, which decoding into maps would lose.
func coauthorResource(q *request) (M, any, error) {
	id := q.Params["id"]
	if id == "" || id == "undefined" {
		return nil, nil, fail(missing("repo"), 404)
	}
	var raw bson.Raw
	err := q.Server.Store.DB.Collection(collection("repo")).FindOne(q.ctx(), resourceFilter("repo", id), options.FindOne().SetCollation(&options.Collation{Locale: "en", Strength: 2})).Decode(&raw)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil, fail(missing("repo"), 404)
	}
	if err != nil {
		return nil, nil, err
	}
	var row M
	if err := bson.Unmarshal(raw, &row); err != nil {
		return nil, nil, err
	}
	var original any
	if value, err := raw.LookupErr("coauthors"); err == nil {
		original = value
	}
	return row, original, nil
}

func coauthorSelf(user security.Identity, list []any, target string) bool {
	if !user.Active() {
		return false
	}
	for _, entry := range list {
		row := obj(entry)
		if !strings.EqualFold(str(row["username"]), target) {
			continue
		}
		// Match the first username entry, as TypeScript's Array.find does.
		if id := str(row["githubId"]); id != "" {
			return id == user.GitHubID
		}
		break
	}
	return user.Username != "" && strings.EqualFold(user.Username, target)
}
