package server

import (
	"regexp"
	"strings"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

// Read the snapshot before the upstream check. A cache hit is read-only, so a
// slow preview cannot overwrite a concurrent forced metadata refresh.
func (s *Server) previewMetadataSnapshot(q *request, id string, a provider.Access) (M, *provider.Repository, error) {
	prefix := externalRepositoryID(id, "")
	filter := M{"name": a.Ref.Name, "externalId": M{"$regex": "^" + regexp.QuoteMeta(prefix)}}
	if a.Ref.ID != "" {
		filter = M{"externalId": externalRepositoryID(id, a.Ref.ID)}
	}
	filter["source"] = M{"$in": []any{id, nil, ""}}
	cached, err := s.Store.one(q.ctx(), "repositories", filter)
	if err != nil || cached == nil {
		return nil, nil, err
	}
	page := obj(cached["pageSource"])
	r := &provider.Repository{ID: strings.TrimPrefix(str(cached["externalId"]), prefix), Name: str(cached["name"]), URL: str(cached["url"]), DefaultBranch: str(cached["defaultBranch"]), Size: number(cached["size"]), HasPage: boolean(cached["hasPage"]), PageBranch: str(page["branch"]), PagePath: str(page["path"])}
	return cached, r, nil
}
