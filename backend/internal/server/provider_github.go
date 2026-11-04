package server

import (
	"context"
	"errors"
	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
)

// GitHub-specific protocol and access binding stay in this adapter. Shared
// preparation, publication and file serving only see provider value types.
type githubProvider struct{ server *Server }

func (g *githubProvider) ID() string { return "github" }
func (g *githubProvider) token(ctx context.Context, a provider.Access) (string, error) {
	owner, e := oid(a.OwnerID)
	if e != nil {
		return "", fail("not_connected", 403)
	}
	return g.server.boundToken(ctx, owner, M(a.Binding), a.Ref.Name)
}
func (g *githubProvider) Connect(ctx context.Context, q provider.ConnectRequest) (provider.Connection, error) {
	owner, e := oid(q.OwnerID)
	if e != nil {
		return provider.Connection{}, fail("not_connected", 403)
	}
	_, binding, resolvedName, e := g.server.selectAccessIdentity(ctx, owner, q.Name, q.Connection, q.RepositoryID)
	if resolvedName == "" {
		resolvedName = q.Name
	}
	repositoryID := str(binding["repositoryId"])
	if repositoryID == "" {
		repositoryID = q.RepositoryID
	}
	return provider.Connection{Ref: provider.Ref{Provider: g.ID(), Name: resolvedName, ID: repositoryID}, Binding: map[string]any(binding)}, e
}
func (g *githubProvider) Authorize(ctx context.Context, a provider.Access) error {
	_, e := g.token(ctx, a)
	return e
}
func (g *githubProvider) Repository(ctx context.Context, a provider.Access) (provider.Repository, error) {
	return g.repositoryMetadata(ctx, a, nil)
}
func (g *githubProvider) PreviewRepository(ctx context.Context, a provider.Access, cached *provider.Repository) (provider.Repository, error) {
	return g.repositoryMetadata(ctx, a, cached)
}
func (g *githubProvider) repositoryMetadata(ctx context.Context, a provider.Access, cached *provider.Repository) (provider.Repository, error) {
	if !safeRepositoryName(a.Ref.Name) {
		return provider.Repository{}, fail("repo_not_found", 404)
	}
	token, e := g.token(ctx, a)
	if e != nil {
		return provider.Repository{}, e
	}
	endpoint := "/repos/" + a.Ref.Name
	// The stable upstream ID survives repository and organization renames.
	if a.Ref.ID != "" {
		endpoint = "/repositories/" + segment(a.Ref.ID)
	}
	raw, e := g.server.githubObject(ctx, "GET", endpoint, token, nil)
	if e != nil {
		return provider.Repository{}, e
	}
	result := provider.Repository{ID: str(raw["id"]), Name: str(raw["full_name"]), URL: str(raw["html_url"]), DefaultBranch: str(raw["default_branch"]), Size: number(raw["size"]), HasPage: boolean(raw["has_pages"])}
	if err := validateRepositoryIdentity(a, result); err != nil {
		return provider.Repository{}, err
	}
	if cached != nil {
		if cached.ID != result.ID {
			return provider.Repository{}, fail("connection_changed", 409)
		}
		return *cached, nil
	}
	if result.HasPage {
		if !safeRepositoryName(result.Name) {
			return provider.Repository{}, fail("github_invalid_response", 502)
		}
		pages, err := g.server.githubObject(ctx, "GET", "/repos/"+result.Name+"/pages", token, nil)
		if err != nil {
			var upstream *githubHTTPError
			if !errors.As(err, &upstream) || upstream.status != 403 && upstream.status != 404 {
				return provider.Repository{}, err
			}
		} else {
			source := obj(pages["source"])
			result.PageBranch, result.PagePath = str(source["branch"]), str(source["path"])
		}
	}
	return result, nil
}
func (g *githubProvider) Commit(ctx context.Context, a provider.Access, ref string) (provider.Commit, error) {
	if !safeRepositoryName(a.Ref.Name) {
		return provider.Commit{}, fail("repo_not_found", 404)
	}
	token, e := g.token(ctx, a)
	if e != nil {
		return provider.Commit{}, e
	}
	raw, e := g.server.githubObject(ctx, "GET", "/repos/"+a.Ref.Name+"/commits/"+segment(ref), token, nil)
	if e != nil {
		return provider.Commit{}, e
	}
	id := str(raw["sha"])
	if !commitID.MatchString(id) {
		return provider.Commit{}, fail("github_invalid_response", 502)
	}
	stamp, valid := storedDate(obj(obj(raw["commit"])["author"])["date"])
	if !valid {
		stamp = date(obj(obj(raw["commit"])["committer"])["date"])
	}
	return provider.Commit{ID: id, Date: stamp}, nil
}
func (g *githubProvider) Tree(ctx context.Context, a provider.Access) ([]provider.Entry, error) {
	entries, _, err := g.TreeWithTruncation(ctx, a)
	return entries, err
}
func (g *githubProvider) TreeWithTruncation(ctx context.Context, a provider.Access) ([]provider.Entry, []string, error) {
	truncated := []string{}
	name, commit := a.Ref.Name, a.Ref.Commit
	if !safeRepositoryName(name) || !commitID.MatchString(commit) {
		return nil, nil, fail("invalid_source", 400)
	}
	token, e := g.token(ctx, a)
	if e != nil {
		return nil, nil, e
	}
	tree, e := g.server.githubObject(ctx, "GET", "/repos/"+name+"/git/trees/"+segment(commit)+"?recursive=1", token, nil)
	if e != nil {
		return nil, nil, e
	}
	entries := arr(tree["tree"])
	if boolean(tree["truncated"]) {
		entries = []any{}
		type dir struct{ sha, prefix string }
		queue := []dir{{commit, ""}}
		for len(queue) > 0 {
			next := queue[0]
			queue = queue[1:]
			sub, e := g.server.githubObject(ctx, "GET", "/repos/"+name+"/git/trees/"+segment(next.sha), token, nil)
			if e != nil {
				return nil, nil, e
			}
			if boolean(sub["truncated"]) {
				truncated = append(truncated, next.prefix)
			}
			for _, v := range arr(sub["tree"]) {
				item := obj(v)
				relative, e := security.RelativePath(str(item["path"]))
				if e != nil {
					return nil, nil, fail("invalid_file_path", 422)
				}
				p := path.Join(next.prefix, relative)
				item["path"] = p
				entries = append(entries, item)
				if str(item["type"]) == "tree" {
					queue = append(queue, dir{str(item["sha"]), p})
				}
			}
		}
	}
	out := make([]provider.Entry, 0, len(entries))
	for _, v := range entries {
		row := obj(v)
		kind := str(row["type"])
		if kind != "blob" && kind != "tree" && kind != "commit" {
			continue
		}
		out = append(out, provider.Entry{Path: str(row["path"]), Revision: str(row["sha"]), Size: number(row["size"]), Directory: kind != "blob"})
	}
	return out, truncated, nil
}
func (g *githubProvider) Open(ctx context.Context, a provider.Access, f provider.Entry) (io.ReadCloser, error) {
	dir, name := path.Split(f.Path)
	return g.server.githubBlob(ctx, providerRecord(a), M{"path": strings.TrimSuffix(dir, "/"), "name": name, "sha": f.Revision, "size": f.Size})
}
func (g *githubProvider) PublicURL(r provider.Ref) string {
	if !safeRepositoryName(r.Name) {
		return ""
	}
	return "https://github.com/" + r.Name
}
func (g *githubProvider) SelfLinks(r provider.Ref) []string {
	if r.Name == "" || r.Branch == "" {
		return []string{}
	}
	return []string{"https://raw.githubusercontent.com/" + r.Name + "/" + r.Branch, "https://github.com/" + r.Name + "/blob/" + r.Branch, "https://github.com/" + r.Name + "/tree/" + r.Branch, "https://github.com/" + r.Name}
}

func (s *Server) githubBlob(ctx context.Context, r, row M) (io.ReadCloser, error) {
	if number(row["size"]) > anonymize.MaxInput {
		return nil, fail("file_too_big", 413)
	}
	source := obj(r["source"])
	name := str(source["repositoryName"])
	if !safeRepositoryName(name) {
		return nil, fail("repo_not_found", 404)
	}
	sha := str(row["sha"])
	if len(sha) != 40 || !commitID.MatchString(sha) {
		return nil, fail("file_not_found", 404)
	}
	token, err := s.boundToken(ctx, r["owner"], obj(r["githubAccess"]), name)
	if err != nil {
		return nil, err
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/"+name+"/git/blobs/"+sha, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github.raw+json")
	req.Header.Set("User-Agent", "Anonymous-GitHub")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if err := s.checkGitHubQuota(ctx, token); err != nil {
		return nil, err
	}
	response, err := s.HTTP.Do(req)
	if err != nil {
		return nil, fail("github_unavailable", 502)
	}
	if githubLimited(response) {
		response.Body.Close()
		return nil, s.recordGitHubQuota(ctx, token, response.Header)
	}
	if response.StatusCode != 200 {
		response.Body.Close()
		if response.StatusCode == 403 || response.StatusCode == 404 || response.StatusCode == 422 {
			return s.rawBlob(ctx, r, row, token)
		}
		return nil, fail("file_not_available", 502)
	}
	if response.ContentLength > anonymize.MaxInput {
		response.Body.Close()
		return nil, fail("file_too_big", 413)
	}
	return s.inspectBlob(ctx, response.Body, r, row, token)
}

func providerRecord(a provider.Access) M {
	owner, _ := oid(a.OwnerID)
	return M{"repoId": a.Ref.AnonymousID, "owner": owner, "source": M{"repositoryName": a.Ref.Name, "branch": a.Ref.Branch, "commit": a.Ref.Commit}, "githubAccess": M(a.Binding)}
}

func (g *githubProvider) Branch(ctx context.Context, a provider.Access, name string) (provider.Commit, error) {
	branches, e := g.Branches(ctx, a)
	if e != nil {
		return provider.Commit{}, e
	}
	for _, b := range branches {
		if b.Name == name {
			return g.Commit(ctx, a, b.Commit)
		}
	}
	return provider.Commit{}, provider.ErrBranchNotFound
}

func (g *githubProvider) FileMetadata(ctx context.Context, a provider.Access, requested string) (*provider.Entry, error) {
	relative, err := security.RelativePath(requested)
	if err != nil || relative != requested || !safeRepositoryName(a.Ref.Name) || !commitID.MatchString(a.Ref.Commit) {
		return nil, fail("invalid_source", 400)
	}
	token, err := g.token(ctx, a)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(requested, "/")
	for i := range parts {
		parts[i] = segment(parts[i])
	}
	raw, err := g.server.githubObject(ctx, "GET", "/repos/"+a.Ref.Name+"/contents/"+strings.Join(parts, "/")+"?ref="+url.QueryEscape(a.Ref.Commit), token, nil)
	if err != nil {
		var upstream *githubHTTPError
		if errors.As(err, &upstream) && upstream.status == 404 {
			return nil, nil
		}
		return nil, err
	}
	if str(raw["type"]) != "file" || str(raw["sha"]) == "" {
		return nil, nil
	}
	return &provider.Entry{Path: requested, Revision: str(raw["sha"]), Size: number(raw["size"])}, nil
}
