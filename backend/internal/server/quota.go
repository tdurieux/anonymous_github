package server

import (
	"context"
	"time"
)

func quotaFilter(owner any, now time.Time) M {
	return M{"owner": owner, "status": "ready", "$or": []M{{"options.expirationMode": "never"}, {"options.expirationDate": M{"$exists": false}}, {"options.expirationDate": nil}, {"options.expirationDate": M{"$gt": now}}}}
}
func quotaSizeCached(row M) bool {
	size := obj(row["size"])
	return len(size) > 0 && (decimal(size["file"]) > 0 || inputTruthy(row["sizeComputedAt"])) && size["storage"] != nil
}
func (s *Server) cacheQuotaSize(ctx context.Context, row, size M, at time.Time) error {
	revision := row["fileMetadataRevision"]
	if !inputTruthy(revision) {
		revision = M{"$exists": false}
	}
	_, err := s.Store.update(ctx, collection("repo"), M{"_id": row["_id"], "status": "ready", "treeGeneration": activeGeneration(row), "fileMetadataRevision": revision}, M{"$set": M{"size": size, "sizeComputedAt": at}})
	return err
}
func (s *Server) quota(q *request) (any, error) {
	rows, err := s.Store.list(q.ctx(), collection("repo"), quotaFilter(q.User["_id"], time.Now()), 0, nil)
	if err != nil {
		return nil, err
	}
	var used, files float64
	uncached := []M{}
	matches := []M{}
	for _, row := range rows {
		if quotaSizeCached(row) {
			size := obj(row["size"])
			used += decimal(size["storage"])
			files += decimal(size["file"])
			continue
		}
		uncached = append(uncached, row)
		matches = append(matches, M{"repoId": row["repoId"], "treeGeneration": activeGeneration(row)})
	}
	if len(uncached) > 0 {
		sizes, err := s.aggregate(q, "files", []M{{"$match": M{"$or": matches}}, {"$group": M{"_id": "$repoId", "storage": M{"$sum": "$size"}, "file": M{"$sum": 1}}}})
		if err != nil {
			return nil, err
		}
		byID := map[string]M{}
		for _, size := range sizes {
			byID[str(size["_id"])] = M{"storage": size["storage"], "file": size["file"]}
		}
		for _, row := range uncached {
			size := byID[str(row["repoId"])]
			if size == nil {
				size = M{"storage": 0, "file": 0}
			}
			used += decimal(size["storage"])
			files += decimal(size["file"])
			if err := s.cacheQuotaSize(q.ctx(), row, size, time.Now().Truncate(time.Millisecond)); err != nil {
				return nil, err
			}
		}
	}
	return M{"storage": M{"used": used, "total": int64(2) * 1024 * 1024 * 1024 * 8}, "file": M{"used": files, "total": 0}, "repository": M{"used": len(rows), "total": 20}}, nil
}
