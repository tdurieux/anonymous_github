package server

import (
	"context"
	"errors"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"net/url"
	"path"
	"regexp"
	"strings"
)

var submoduleOwner = regexp.MustCompile(`^[A-Za-z0-9-]+$`)
var submoduleRepo = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

func submoduleRepository(raw, parent string) string {
	normalized := raw
	for _, prefix := range []string{"git@github.com:", "ssh://git@github.com/", "git://github.com/"} {
		if strings.HasPrefix(raw, prefix) {
			normalized = "https://github.com/" + strings.TrimPrefix(raw, prefix)
		}
	}
	u, err := url.Parse(normalized)
	if err != nil {
		return ""
	}
	if strings.HasPrefix(raw, "./") || strings.HasPrefix(raw, "../") {
		base, _ := url.Parse("https://github.com/" + parent + "/")
		u = base.ResolveReference(u)
	}
	if u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	name := strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(u.Path, "/"), "/"), ".git")
	parts := strings.Split(name, "/")
	if len(parts) != 2 || !submoduleOwner.MatchString(parts[0]) || !submoduleRepo.MatchString(parts[1]) || parts[1] == "." || parts[1] == ".." {
		return ""
	}
	return name
}
func upstreamOrigin(value any) *provider.FileOrigin {
	row := obj(value)
	if len(row) == 0 {
		return nil
	}
	return &provider.FileOrigin{Provider: "github", Repository: str(row["organization"]) + "/" + str(row["repoName"]), Commit: str(row["commit"]), Path: str(row["path"])}
}
func validFileOrigin(origin *provider.FileOrigin) bool {
	return origin != nil && origin.Provider == "github" && submoduleRepository("https://github.com/"+origin.Repository, "") == origin.Repository && gitBlobSHA.MatchString(origin.Commit) && safeSourcePath(origin.Path)
}
func originDocument(origin *provider.FileOrigin) M {
	if origin == nil {
		return nil
	}
	parts := strings.SplitN(origin.Repository, "/", 2)
	if len(parts) != 2 {
		return nil
	}
	return M{"organization": parts[0], "repoName": parts[1], "commit": origin.Commit, "path": origin.Path}
}
func fileProviderEntry(row M) provider.Entry {
	return provider.Entry{Path: path.Join(str(row["path"]), str(row["name"])), Revision: str(row["sha"]), Size: number(row["size"]), Origin: upstreamOrigin(row["upstream"]), Submodule: str(row["submodule"])}
}
func (g *githubProvider) expandSubmodules(ctx context.Context, a provider.Access, token string, entries []provider.Entry) ([]provider.Entry, error) {
	out := make([]provider.Entry, 0, len(entries))
	for _, entry := range entries {
		if path.Base(entry.Path) != ".gitmodules" {
			out = append(out, entry)
		}
	}
	count, remaining := 0, 10000
	parents := len(out)
	for i := 0; i < parents; i++ {
		mount := &out[i]
		if mount.Submodule == "" {
			continue
		}
		count++
		if count > 20 {
			mount.Submodule = "limit"
			continue
		}
		if !safeSourcePath(mount.Path) || !gitBlobSHA.MatchString(mount.Revision) {
			continue
		}
		metadata, err := g.server.githubObject(ctx, "GET", "/repos/"+a.Ref.Name+"/contents/"+escapeRepositoryPath(mount.Path)+"?ref="+url.QueryEscape(a.Ref.Commit), token, nil)
		if err != nil {
			var upstream *githubHTTPError
			if errors.As(err, &upstream) && upstream.status == 404 {
				mount.Submodule = "unavailable"
				continue
			}
			return nil, err
		}
		name := submoduleRepository(str(metadata["submodule_git_url"]), a.Ref.Name)
		if name == "" || metadata["sha"] != mount.Revision {
			continue
		}
		tree, err := g.server.githubObject(ctx, "GET", "/repos/"+name+"/git/trees/"+mount.Revision+"?recursive=1", "", nil)
		if err != nil {
			var upstream *githubHTTPError
			if errors.As(err, &upstream) && (upstream.status == 404 || upstream.status == 422) {
				mount.Submodule = "unavailable"
				continue
			}
			return nil, err
		}
		rows := arr(tree["tree"])
		if boolean(tree["truncated"]) || len(rows) > remaining {
			mount.Submodule = "limit"
			continue
		}
		safe := true
		for _, raw := range rows {
			if !safeSourcePath(str(obj(raw)["path"])) {
				safe = false
				break
			}
		}
		if !safe {
			mount.Submodule = "unsupported"
			continue
		}
		remaining -= len(rows)
		mount.Submodule = "included"
		prefix, commit := mount.Path, mount.Revision
		mount.Origin = &provider.FileOrigin{Provider: "github", Repository: name, Commit: commit}
		for _, raw := range rows {
			row := obj(raw)
			relative := str(row["path"])
			if path.Base(relative) == ".gitmodules" {
				continue
			}
			entry := provider.Entry{Path: prefix + "/" + relative, Revision: str(row["sha"]), Size: number(row["size"]), Directory: row["type"] != "blob"}
			if row["type"] == "commit" {
				entry.Submodule = "nested"
			}
			if row["type"] == "blob" {
				entry.Origin = &provider.FileOrigin{Provider: "github", Repository: name, Commit: commit, Path: relative}
			}
			out = append(out, entry)
		}
	}
	return out, nil
}
func escapeRepositoryPath(value string) string {
	parts := strings.Split(value, "/")
	for i := range parts {
		parts[i] = segment(parts[i])
	}
	return strings.Join(parts, "/")
}
func (s *Server) assertFileOrigin(ctx context.Context, row M) error {
	if row["upstream"] == nil {
		return nil
	}
	origin := upstreamOrigin(row["upstream"])
	if !validFileOrigin(origin) {
		return fail("invalid_source", 400)
	}
	// This check deliberately carries no parent credential: a private dependency
	// cannot acquire access merely because its parent repository is authorized.
	_, err := s.githubObject(ctx, "GET", "/repos/"+origin.Repository+"/commits/"+origin.Commit, "", nil)
	if err != nil {
		var upstream *githubHTTPError
		if errors.As(err, &upstream) && (upstream.status == 404 || upstream.status == 422) {
			return fail("submodule_not_available", 404)
		}
		return err
	}
	return nil
}
