package server

import (
	"context"
	"strings"
)

// Aggregate by original directory before transforming paths. The number of
// anonymizations now depends on folders, not on every file and ancestor pair.
func (s *Server) folderCounts(ctx context.Context, r M) (M, error) {
	cursor, err := s.Store.DB.Collection("files").Aggregate(ctx, []M{
		{"$match": M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r), "size": M{"$ne": nil}}},
		{"$group": M{"_id": "$path", "count": M{"$sum": 1}}},
	})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	original := map[string]int64{}
	for cursor.Next(ctx) {
		var row M
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		p, count := str(row["_id"]), number(row["count"])
		for {
			original[p] += count
			if p == "" {
				break
			}
			if i := strings.LastIndexByte(p, '/'); i >= 0 {
				p = p[:i]
			} else {
				p = ""
			}
		}
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	engine, err := s.engine(r, "repo")
	if err != nil {
		return nil, err
	}
	counts := M{}
	for p, count := range original {
		anonymous, err := engine.Path(ctx, p)
		if err != nil {
			return nil, err
		}
		counts[anonymous] = number(counts[anonymous]) + count
	}
	return counts, nil
}
