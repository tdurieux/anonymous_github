package server

import (
	"context"
	"errors"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func (s *Server) connectionGrants(ctx context.Context, owner any) ([]M, error) {
	cursor, err := s.Store.DB.Collection("credentials").Find(ctx, M{"ownerId": owner, "provider": M{"$in": []string{"github", "github-app-user"}}}, options.Find().SetProjection(M{"_id": 0, "provider": 1, "revoked": 1}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	rows := []M{}
	err = cursor.All(ctx, &rows)
	return rows, err
}

func (s *Server) storedGrantEnvelope(ctx context.Context, owner any, provider string) (M, error) {
	var row M
	err := s.Store.DB.Collection("credentials").FindOne(ctx, M{"ownerId": owner, "provider": provider}, options.FindOne().SetProjection(M{"_id": 0, "encryptedToken": 1})).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return row, err
}

// Stream only the fields displayed by the connection page. Large PR payloads,
// source credentials and provider-private metadata never enter the summary read.
func (s *Server) connectionResources(ctx context.Context, owner any) ([]M, error) {
	resources := []M{}
	for _, kind := range []string{"repo", "pr"} {
		typ, nameField := "repository", "repositoryName"
		if kind == "pr" {
			typ, nameField = "pull-request", "repositoryFullName"
		}
		projection := M{"_id": 0, idKey(kind): 1, "source." + nameField: 1, "githubAccess.kind": 1, "status": 1, "statusDate": 1}
		cursor, err := s.Store.DB.Collection(collection(kind)).Find(ctx, githubSources(M{"owner": owner, "status": M{"$ne": "removed"}}), options.Find().SetProjection(projection))
		if err != nil {
			return nil, err
		}
		err = func() error {
			defer cursor.Close(ctx)
			for cursor.Next(ctx) {
				var row M
				if err := cursor.Decode(&row); err != nil {
					return err
				}
				connection := str(obj(row["githubAccess"])["kind"])
				if connection == "" {
					connection = "oauth"
				}
				resources = append(resources, M{"type": typ, "id": row[idKey(kind)], "name": str(obj(row["source"])[nameField]), "connection": connection, "status": row["status"], "statusDate": row["statusDate"]})
			}
			return cursor.Err()
		}()
		if err != nil {
			return nil, err
		}
	}
	return resources, nil
}
