package server

import (
	"context"
	"errors"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"strings"
)

// Missing provider fields only mean GitHub for recognized legacy source types.
func sourceProvider(source M) (string, error) {
	if id := str(source["provider"]); id != "" {
		return id, nil
	}
	switch str(source["type"]) {
	case "Zip":
		return "archive", nil
	case "", "GitHubStream", "GitHubDownload":
		return "github", nil
	}
	return "", fail("provider_not_supported", 400)
}
func providerFailure(e error) error {
	for _, category := range []struct {
		err    error
		code   string
		status int
	}{
		{provider.ErrBranchNotFound, "branch_not_found", 404},
		{provider.ErrUnknown, "provider_not_supported", 400},
		{provider.ErrCapability, "provider_capability_not_supported", 400},
		{provider.ErrNotFound, "resource_not_found", 404},
		{provider.ErrAccessDenied, "not_authorized", 403},
		{provider.ErrRateLimited, "rate_limited", 429},
		{provider.ErrUpstream, "upstream_error", 502},
	} {
		if errors.Is(e, category.err) {
			api := &APIError{Code: category.code, Status: category.status}
			var limited *provider.RateLimitError
			if errors.As(e, &limited) && limited != nil && !limited.ResetAt.IsZero() {
				api.ResetAt = limited.ResetAt.UnixMilli()
			}
			return api
		}
	}
	return e
}

func (s *Server) providerAccess(r M) (provider.Access, error) {
	source := obj(r["source"])
	id, e := sourceProvider(source)
	if e != nil {
		return provider.Access{}, e
	}
	binding := obj(r["providerAccess"])
	if id == "github" {
		binding = obj(r["githubAccess"])
	}
	if declared := str(binding["provider"]); declared != "" && declared != id {
		return provider.Access{}, fail("provider_binding_mismatch", 409)
	}
	name := str(source["repositoryName"])
	if name == "" {
		name = str(source["repositoryFullName"])
	}
	return provider.Access{OwnerID: str(r["owner"]), Ref: provider.Ref{Provider: id, ID: str(source["providerRepositoryId"]), Name: name, Branch: str(source["branch"]), Commit: str(source["commit"]), AnonymousID: str(r["repoId"])}, Binding: map[string]any(binding)}, nil
}
func (s *Server) repositoryProvider(r M) (provider.Repositories, provider.Access, error) {
	access, e := s.providerAccess(r)
	if e != nil {
		return nil, access, e
	}
	p, e := s.providers.Repositories(access.Ref.Provider)
	return p, access, providerFailure(e)
}
func (s *Server) authorizeSource(ctx context.Context, r M) (resultErr error) {
	done := s.startStage(ctx, "authorization")
	defer func() { done(resultErr) }()
	p, a, e := s.repositoryProvider(r)
	if e != nil {
		return e
	}
	return p.Authorize(ctx, a)
}
func (s *Server) documentProvider(r M, kind string) (provider.Documents, provider.DocumentRequest, error) {
	a, e := s.providerAccess(r)
	q := provider.DocumentRequest{Access: a, Kind: kind, ID: str(obj(r["source"])["gistId"]), Number: number(obj(r["source"])["pullRequestId"])}
	if e != nil {
		return nil, q, e
	}
	p, e := s.providers.Get(a.Ref.Provider)
	if e != nil {
		return nil, q, providerFailure(e)
	}
	d, ok := p.(provider.Documents)
	if !ok {
		return nil, q, providerFailure(provider.ErrCapability)
	}
	return d, q, nil
}
func (s *Server) downloadEmbedded(ctx context.Context, kind string, r M) (M, error) {
	p, q, e := s.documentProvider(r, kind)
	if e != nil {
		return nil, e
	}
	done := s.startStage(ctx, "upstream")
	v, e := p.Document(ctx, q)
	done(e)
	return M(v), e
}
func (s *Server) sourceURL(r M, kind string) (string, error) {
	if kind == "repo" {
		p, a, e := s.repositoryProvider(r)
		if e != nil {
			return "", e
		}
		return p.PublicURL(a.Ref), nil
	}
	p, q, e := s.documentProvider(r, kind)
	if e != nil {
		return "", e
	}
	return p.DocumentURL(q), nil
}

func (s *Server) providerCapabilities(q *request) (any, error) {
	out := []M{}
	for _, id := range s.providers.IDs() {
		p, _ := s.providers.Get(id)
		_, repositories := p.(provider.Repositories)
		_, discovery := p.(provider.Discovery)
		_, documents := p.(provider.Documents)
		out = append(out, M{"id": id, "repositories": repositories, "discovery": discovery, "documents": documents})
	}
	return out, nil
}

// Upgrade legacy GitHub references through the cached immutable upstream ID.
// A renamed repository must not accidentally bind to a new repository at its old name.
func (s *Server) resolveSourceIdentity(ctx context.Context, r M, a provider.Access) (provider.Access, error) {
	if a.Ref.Provider != "github" || a.Ref.ID != "" {
		return a, nil
	}
	if id := str(a.Binding["repositoryId"]); id != "" {
		a.Ref.ID = id
		return a, nil
	}
	cachedID := str(obj(r["source"])["repositoryId"])
	if cachedID == "" {
		return a, nil
	}
	id, e := oid(cachedID)
	if e != nil {
		return a, fail("repo_not_found", 404)
	}
	cached, e := s.Store.one(ctx, "repositories", M{"_id": id})
	if e != nil {
		return a, e
	}
	external := str(cached["externalId"])
	if !strings.HasPrefix(external, "gh_") || len(external) <= 3 {
		return a, fail("repo_not_found", 404)
	}
	a.Ref.ID = strings.TrimPrefix(external, "gh_")
	return a, nil
}
func validateRepositoryIdentity(a provider.Access, r provider.Repository) error {
	if r.ID == "" || r.Name == "" {
		return fail("provider_invalid_response", 502)
	}
	if a.Ref.ID != "" && a.Ref.ID != r.ID {
		return fail("connection_changed", 409)
	}
	return nil
}

// Provider-specific account tools must not treat other providers as legacy OAuth.
func githubSources(filter M) M {
	out := M{}
	for k, v := range filter {
		out[k] = v
	}
	source := M{"$or": []M{{"source.provider": "github"}, {"source.provider": M{"$in": []any{nil, ""}}, "source.type": M{"$in": []any{nil, "", "GitHubStream", "GitHubDownload"}}}}}
	out["$and"] = []M{source}
	return out
}

// Connection identity comes from the selected adapter, never from the client.
func connectionAccess(owner, id string, connection provider.Connection) (provider.Access, error) {
	if connection.Ref.Provider != "" && connection.Ref.Provider != id {
		return provider.Access{}, fail("provider_binding_mismatch", 409)
	}
	if declared := str(connection.Binding["provider"]); declared != "" && declared != id {
		return provider.Access{}, fail("provider_binding_mismatch", 409)
	}
	access := provider.Access{OwnerID: owner, Ref: connection.Ref, Binding: connection.Binding}
	access.Ref.Provider = id
	return access, nil
}
