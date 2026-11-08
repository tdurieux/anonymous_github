package server

import (
	"context"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func (s *Store) ensureIndexes(ctx context.Context) error {
	for _, kind := range []string{"repo", "pr", "gist"} {
		index := mongo.IndexModel{Keys: bson.D{{Key: idKey(kind), Value: 1}}, Options: options.Index().SetUnique(true)}
		if kind == "repo" {
			index.Options.SetCollation(&options.Collation{Locale: "en", Strength: 2})
		}
		if _, e := s.DB.Collection(collection(kind)).Indexes().CreateOne(ctx, index); e != nil {
			return e
		}
	}
	indexes := map[string][]mongo.IndexModel{
		"gocachemetrics":         {{Keys: bson.D{{Key: "period", Value: 1}, {Key: "bucket", Value: 1}}}, {Keys: bson.D{{Key: "expires", Value: 1}}, Options: options.Index().SetExpireAfterSeconds(0)}},
		"anonymizedrepositories": {{Keys: bson.D{{Key: "conferenceMembership.id", Value: 1}}, Options: options.Index().SetSparse(true)}},
		"users":                  {{Keys: bson.D{{Key: "username", Value: 1}}, Options: options.Index().SetUnique(true)}, {Keys: bson.D{{Key: "externalIDs.github", Value: 1}}}, {Keys: bson.D{{Key: "apiTokens.tokenHash", Value: 1}}}},
		"repositories":           {{Keys: bson.D{{Key: "externalId", Value: 1}}, Options: options.Index().SetUnique(true)}},
		"githubinstallations":    {{Keys: bson.D{{Key: "appId", Value: 1}, {Key: "installationId", Value: 1}}, Options: options.Index().SetUnique(true)}},
		"files":                  {{Keys: bson.D{{Key: "repoId", Value: 1}, {Key: "treeGeneration", Value: 1}, {Key: "path", Value: 1}, {Key: "name", Value: 1}}}, {Keys: bson.D{{Key: "metadataPending", Value: 1}, {Key: "repoId", Value: 1}, {Key: "treeGeneration", Value: 1}}, Options: options.Index().SetPartialFilterExpression(M{"metadataPending": true})}},
		"gojobs":                 {{Keys: bson.D{{Key: "state", Value: 1}, {Key: "priority", Value: 1}, {Key: "availableAt", Value: 1}, {Key: "queueOrder", Value: 1}, {Key: "createdAt", Value: 1}, {Key: "_id", Value: 1}}}, {Keys: bson.D{{Key: "kind", Value: 1}, {Key: "resourceId", Value: 1}, {Key: "action", Value: 1}, {Key: "state", Value: 1}}}, {Keys: bson.D{{Key: "state", Value: 1}, {Key: "availableAt", Value: 1}}}, {Keys: bson.D{{Key: "state", Value: 1}, {Key: "leaseUntil", Value: 1}}}, {Keys: bson.D{{Key: "action", Value: 1}, {Key: "state", Value: 1}, {Key: "createdAt", Value: -1}}}},
		"dashboardnames":         {{Keys: bson.D{{Key: "owner", Value: 1}, {Key: "type", Value: 1}, {Key: "artifactId", Value: 1}}, Options: options.Index().SetUnique(true)}},
		"dailystats":             {{Keys: bson.D{{Key: "date", Value: 1}}, Options: options.Index().SetUnique(true)}},
		"conferences":            {{Keys: bson.D{{Key: "conferenceID", Value: 1}}, Options: options.Index().SetUnique(true)}},
	}
	for coll, models := range indexes {
		if _, e := s.DB.Collection(coll).Indexes().CreateMany(ctx, models); e != nil {
			return e
		}
	}
	return nil
}
