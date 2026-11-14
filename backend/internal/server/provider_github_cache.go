package server

import (
	"context"
	"strings"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func (g *githubProvider) cachedRepositories(ctx context.Context, user M) ([]provider.Repository, error) {
	ids := []bson.ObjectID{}
	for _, value := range arr(user["repositories"]) {
		if id, err := oid(str(value)); err == nil {
			ids = append(ids, id)
		}
	}
	// Match TypeScript's find($in) behavior: database order, unique rows, and
	// missing references omitted. Other providers never enter GitHub discovery.
	rows, err := g.server.Store.list(ctx, "repositories", M{"_id": M{"$in": ids}, "externalId": M{"$regex": "^gh_"}}, 0, nil)
	if err != nil {
		return nil, err
	}
	out := []provider.Repository{}
	for _, row := range rows {
		out = append(out, provider.Repository{ID: strings.TrimPrefix(str(row["externalId"]), "gh_"), Name: str(row["name"]), URL: str(row["url"]), Size: number(row["size"]), DefaultBranch: str(row["defaultBranch"]), HasPage: boolean(row["hasPage"])})
	}
	return out, nil
}

func (g *githubProvider) cacheRepositories(ctx context.Context, user M, repos []provider.Repository) error {
	ids := []bson.ObjectID{}
	externalIDs := make([]string, 0, len(repos))
	for _, repo := range repos {
		externalIDs = append(externalIDs, externalRepositoryID("github", repo.ID))
	}
	existing, err := g.server.Store.list(ctx, "repositories", M{"externalId": M{"$in": externalIDs}}, 0, nil)
	if err != nil {
		return err
	}
	byExternalID := map[string]M{}
	for _, row := range existing {
		byExternalID[str(row["externalId"])] = row
	}
	for _, repo := range repos {
		external := externalRepositoryID("github", repo.ID)
		cached := byExternalID[external]
		if cached == nil {
			// TypeScript reuses existing rows without overwriting their metadata.
			// Atomic insertion also prevents duplicate rows from concurrent discovery.
			insert := M{"_id": bson.NewObjectID(), "externalId": external, "name": repo.Name, "url": repo.URL, "size": repo.Size, "defaultBranch": repo.DefaultBranch, "source": "github", "hasPage": false, "status": "ready", "branches": []any{}, "dateOfEntry": time.Now(), "__v": 0}
			err := g.server.Store.DB.Collection("repositories").FindOneAndUpdate(ctx, M{"externalId": external}, M{"$setOnInsert": insert}, options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&cached)
			if mongo.IsDuplicateKeyError(err) {
				cached, err = g.server.Store.one(ctx, "repositories", M{"externalId": external})
			}
			if err != nil {
				return err
			}

			byExternalID[external] = cached
		}
		id, err := oid(str(cached["_id"]))
		if err != nil {
			return err
		}
		ids = append(ids, id)
	}
	filter := M{"_id": user["_id"], "status": user["status"]}
	if revision, ok := user["repositoryDiscoveryRevision"]; ok {
		filter["repositoryDiscoveryRevision"] = revision
	} else {
		filter["repositoryDiscoveryRevision"] = M{"$exists": false}
	}
	// Reconnecting/disconnecting while discovery is in flight invalidates this
	// publication, including when the old and new saved lists are both empty.
	matched, err := g.server.Store.update(ctx, "users", filter, M{"$set": M{"repositories": ids}})
	if err != nil {
		return err
	}
	if !matched {
		return fail("connection_changed", 409)
	}
	return nil
}
