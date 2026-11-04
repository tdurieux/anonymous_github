package server

import (
	"context"
	"fmt"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

func (g *githubProvider) List(ctx context.Context, request provider.ListRequest) ([]provider.Repository, error) {
	s := g.server
	owner, err := oid(request.OwnerID)
	if err != nil {
		return nil, fail("not_connected", 403)
	}
	repos := map[string]provider.Repository{}
	order := []string{}
	remember := func(r M) {
		id := "gh_" + str(r["id"])
		if _, exists := repos[id]; !exists {
			order = append(order, id)
		}
		repos[id] = provider.Repository{Name: str(r["full_name"]), ID: str(r["id"]), URL: str(r["html_url"]), Size: number(r["size"]), DefaultBranch: str(r["default_branch"])}
	}
	oauth, err := s.Store.one(ctx, "credentials", M{"ownerId": owner, "provider": "github", "revoked": M{"$ne": true}})
	if err != nil {
		return nil, err
	}
	app, err := s.Store.one(ctx, "credentials", M{"ownerId": owner, "provider": "github-app-user"})
	if err != nil {
		return nil, err
	}
	useApp := s.Config.AppEnabled && app != nil
	user, err := s.Store.one(ctx, "users", M{"_id": owner})
	if err != nil {
		return nil, err
	}
	if !identity(user).Active() {
		return nil, fail("not_connected", 403)
	}
	if !useApp && !request.Force && len(arr(user["repositories"])) > 0 {
		return g.cachedRepositories(ctx, user)
	}
	var oauthToken string
	if oauth != nil {
		oauthToken, err = s.credential(ctx, owner, "github")
		if err != nil {
			return nil, err
		}
	}
	var appRepos []M
	if useApp {
		appRepos, err = g.appRepositories(ctx, request.OwnerID)
		if err != nil && oauth == nil {
			return nil, err
		}
		// App discovery is atomic: never publish a partial installation list.
		// An independently connected OAuth grant can still supply discovery.
		if err != nil {
			appRepos = nil
		}
	}
	if oauth != nil {
		endpoint := "/user/repos?visibility=all"
		if !useApp {
			endpoint += "&sort=pushed"
		}
		err := s.githubPages(ctx, endpoint, oauthToken, "", func(r M) bool { remember(r); return false })
		if err != nil {
			return nil, err
		}
	}
	for _, r := range appRepos {
		remember(r)
	}
	if oauth == nil && (!s.Config.AppEnabled || app == nil) {
		return nil, fail("github_oauth_required", 403)
	}
	out := []provider.Repository{}
	for _, id := range order {
		out = append(out, repos[id])
	}

	if !useApp {
		if err := g.cacheRepositories(ctx, user, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// appRepositories returns all installations' repositories or an error. Keeping
// this operation separate makes OAuth fallback cover every App request failure.
func (g *githubProvider) appRepositories(ctx context.Context, ownerID string) ([]M, error) {
	owner, err := oid(ownerID)
	if err != nil {
		return nil, fail("not_connected", 403)
	}
	s := g.server
	items, err := s.installations(ctx, owner)
	if err != nil {
		return nil, err
	}
	token, err := s.credential(ctx, owner, "github-app-user")
	if err != nil {
		return nil, err
	}
	out := []M{}
	for _, installation := range items {
		if inputTruthy(installation["suspended_at"]) {
			continue
		}
		err := s.githubPages(ctx, fmt.Sprintf("/user/installations/%d/repositories", number(installation["id"])), token, "repositories", func(r M) bool {
			out = append(out, r)
			return false
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (g *githubProvider) Branches(ctx context.Context, a provider.Access) ([]provider.Branch, error) {
	if !safeRepositoryName(a.Ref.Name) {
		return nil, fail("repo_not_found", 404)
	}
	token, e := g.token(ctx, a)
	if e != nil {
		return nil, e
	}

	out := []provider.Branch{}
	e = g.server.githubPages(ctx, "/repos/"+a.Ref.Name+"/branches", token, "", func(r M) bool {
		out = append(out, provider.Branch{Name: str(r["name"]), Commit: str(obj(r["commit"])["sha"])})
		return false
	})
	if e != nil {
		return nil, e
	}
	return out, nil
}

func (g *githubProvider) Readme(ctx context.Context, a provider.Access, branch string) (string, error) {
	if !safeRepositoryName(a.Ref.Name) {
		return "", fail("repo_not_found", 404)
	}
	token, e := g.token(ctx, a)
	if e != nil {
		return "", e
	}
	endpoint := "/repos/" + a.Ref.Name + "/readme"
	if branch != "" {
		endpoint += "?ref=" + queryEscape(branch)
	}
	raw, e := g.server.github(ctx, "GET", endpoint, token, nil)
	if e != nil {
		return "", e
	}
	return decodeGitHubReadme(raw)
}
