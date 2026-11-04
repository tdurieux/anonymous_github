package server

import (
	"context"
	"errors"
	"path"
	"strings"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func folderQuery(raw string) (string, error) {
	value := parseExtendedQuery(raw).object["path"]
	if !value.truthy() {
		return "", nil
	}
	requested, ok := value.scalarValue()
	if !ok {
		return "", errors.New("invalid_query_value")
	}
	return requested, nil
}

func (s *Server) originalFolder(ctx context.Context, repo M, requested string) (string, error) {
	resolve := strings.Contains(requested, s.Config.Mask)
	for _, term := range arr(obj(repo["options"])["terms"]) {
		_, _, custom := anonymize.ParseTerm(str(term))
		resolve = resolve || custom
	}
	if requested == "" || !resolve {
		return requested, nil
	}
	filter := M{"repoId": repo["repoId"], "treeGeneration": activeGeneration(repo)}
	directory, name := folderPathParts(requested)
	filter["path"] = directory
	if name != "" {
		filter["name"] = name
	}
	exact, err := s.Store.one(ctx, "files", filter)
	if err != nil {
		return "", err
	}
	if exact != nil {
		if err := s.completeRecoveredMetadata(ctx, repo, exact); err != nil {
			return "", err
		}
		return path.Join(str(exact["path"]), str(exact["name"])), nil
	}
	delete(filter, "path")
	delete(filter, "name")
	cursor, err := s.Store.DB.Collection("files").Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "path", Value: 1}, {Key: "name", Value: 1}}).SetBatchSize(256).SetProjection(M{"path": 1, "name": 1, "metadataPending": 1, "recoverySnapshot": 1}))
	if err != nil {
		return "", err
	}
	defer cursor.Close(ctx)
	engine, err := s.engine(repo, "repo")
	if err != nil {
		return "", err
	}
	for cursor.Next(ctx) {
		var row M
		if err := cursor.Decode(&row); err != nil {
			return "", err
		}
		original := path.Join(str(row["path"]), str(row["name"]))
		transformed, err := engine.Path(ctx, original)
		if err != nil {
			return "", err
		}
		if transformed == requested {
			if err := s.completeRecoveredMetadata(ctx, repo, row); err != nil {
				return "", err
			}
			return original, nil
		}
	}
	if err := cursor.Err(); err != nil {
		return "", err
	}
	recovered, err := s.recoverTruncatedFile(ctx, repo, requested)
	if err != nil {
		return "", err
	}
	return path.Join(str(recovered["path"]), str(recovered["name"])), nil
}

// Match the POSIX dirname/basename operations used by AnonymizedFile before
// its exact Mongo lookup, including trailing and repeated separators.
func folderPathParts(requested string) (string, string) {
	directory := "."
	if len(requested) > 0 {
		root := requested[0] == '/'
		end := -1
		trailing := true
		for i := len(requested) - 1; i >= 1; i-- {
			if requested[i] == '/' {
				if !trailing {
					end = i
					break
				}
			} else {
				trailing = false
			}
		}
		if end < 0 {
			if root {
				directory = "/"
			}
		} else if root && end == 1 {
			directory = "//"
		} else {
			directory = requested[:end]
		}
	}
	if directory == "." {
		directory = ""
	}
	directory = strings.TrimSuffix(directory, "/")
	trimmed := strings.TrimRight(requested, "/")
	name := trimmed
	if i := strings.LastIndexByte(trimmed, '/'); i >= 0 {
		name = trimmed[i+1:]
	}
	return directory, name
}
