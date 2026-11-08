package server

import (
	"context"
	"errors"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
)

func previewBranchJSON(branch provider.Branch) M {
	row := M{"name": branch.Name, "commit": branch.Commit}
	if branch.Readme != nil {
		row["readme"] = *branch.Readme
	}
	return row
}
func storedPreviewBranches(row M) []provider.Branch {
	out := []provider.Branch{}
	for _, value := range arr(row["branches"]) {
		item := obj(value)
		branch := provider.Branch{Name: str(item["name"]), Commit: str(item["commit"])}
		if readme, ok := item["readme"].(string); ok {
			branch.Readme = &readme
		}
		out = append(out, branch)
	}
	return out
}
func discoveryRevisionFilter(cached M) M {
	filter := M{"_id": cached["_id"]}
	if revision, present := cached["goDiscoveryRevision"]; present {
		filter["goDiscoveryRevision"] = revision
	} else {
		filter["goDiscoveryRevision"] = M{"$exists": false}
	}
	return filter
}
func branchPreviewFailure(err error) error {
	status := 404
	var upstream *githubHTTPError
	if errors.As(err, &upstream) {
		status = upstream.status
	}
	return fail("repo_not_found", status)
}
func (g *githubProvider) PreviewBranches(ctx context.Context, a provider.Access, force bool) ([]provider.Branch, error) {
	if _, err := g.token(ctx, a); err != nil {
		return nil, err
	}
	cached, err := g.server.Store.one(ctx, "repositories", M{"externalId": externalRepositoryID("github", a.Ref.ID)})
	if err != nil {
		return nil, err
	}
	if cached == nil {
		return nil, fail("repo_not_found", 404)
	}
	previous := storedPreviewBranches(cached)
	if len(previous) > 0 && !force {
		return previous, nil
	}
	fresh, err := g.Branches(ctx, a)
	if err != nil {
		return nil, branchPreviewFailure(err)
	}
	readmes := map[string]*string{}
	for _, branch := range previous {
		if _, exists := readmes[branch.Name]; !exists {
			readmes[branch.Name] = branch.Readme
		}
	}
	rows := []M{}
	for i := range fresh {
		fresh[i].Readme = readmes[fresh[i].Name]
		rows = append(rows, previewBranchJSON(fresh[i]))
	}
	revision, err := security.RandomToken()
	if err != nil {
		return nil, branchPreviewFailure(err)
	}
	if _, err := g.server.Store.update(ctx, "repositories", discoveryRevisionFilter(cached), M{"$set": M{"branches": rows, "goDiscoveryRevision": revision}}); err != nil {
		return nil, branchPreviewFailure(err)
	}
	return fresh, nil
}
func (g *githubProvider) PreviewReadme(ctx context.Context, a provider.Access, branch string, force bool) (string, error) {
	if branch == "" {
		branch = "master"
	}
	return g.PreviewSelectedReadme(ctx, a, func(name string) (bool, error) { return name == branch, nil }, force)
}

func (g *githubProvider) PreviewSelectedReadme(ctx context.Context, a provider.Access, matches provider.BranchMatch, force bool) (string, error) {
	cached, err := g.server.Store.one(ctx, "repositories", M{"externalId": externalRepositoryID("github", a.Ref.ID)})
	if err != nil {
		return "", err
	}
	if cached == nil {
		return "", fail("repo_not_found", 404)
	}
	branches, err := g.PreviewBranches(ctx, a, force)
	if err != nil {
		return "", err
	}
	var selected *provider.Branch
	for i := range branches {
		match, err := matches(branches[i].Name)
		if err != nil {
			return "", err
		}
		if match && selected == nil {
			selected = &branches[i]
		}
	}
	if selected == nil {
		return "", fail("readme_not_available", 404)
	}
	if selected.Readme != nil && *selected.Readme != "" && !force {
		return *selected.Readme, nil
	}
	// Resolve README content at the branch snapshot's commit, not a moving name.
	value, err := g.Readme(ctx, a, selected.Commit)
	if err != nil {
		return "", fail("readme_not_available", 404)
	}
	revision, err := security.RandomToken()
	if err != nil {
		return "", fail("readme_not_available", 404)
	}
	filter := M{"_id": cached["_id"], "branches": M{"$elemMatch": M{"name": selected.Name, "commit": selected.Commit}}}
	if _, err := g.server.Store.update(ctx, "repositories", filter, M{"$set": M{"branches.$.readme": value, "goDiscoveryRevision": revision}}); err != nil {
		return "", fail("readme_not_available", 404)
	}
	return value, nil
}
