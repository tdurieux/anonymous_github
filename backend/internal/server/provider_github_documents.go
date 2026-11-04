package server

import (
	"context"
	"encoding/base64"
	"fmt"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

func (g *githubProvider) Document(ctx context.Context, q provider.DocumentRequest) (map[string]any, error) {
	r := providerRecord(q.Access)
	r["source"] = M{"gistId": q.ID, "repositoryFullName": q.Access.Ref.Name, "pullRequestId": q.Number}
	return g.server.githubDocument(ctx, q.Kind, r)
}
func (g *githubProvider) DocumentURL(q provider.DocumentRequest) string {
	if q.Kind == "gist" {
		return "https://gist.github.com/" + segment(q.ID)
	}
	if !safeRepositoryName(q.Access.Ref.Name) {
		return ""
	}
	return fmt.Sprintf("https://github.com/%s/pull/%d", q.Access.Ref.Name, q.Number)
}
func (s *Server) githubDocument(ctx context.Context, kind string, r M) (M, error) {
	source := obj(r["source"])
	var payload M
	var token string
	var err error
	if kind == "gist" {
		provider := "github"
		if s.Config.AppEnabled {
			grant, e := s.Store.one(ctx, "credentials", M{"ownerId": r["owner"], "provider": "github-app-user"})
			if e != nil {
				return nil, e
			}
			if grant != nil {
				provider = "github-app-user"
			}
		}
		token, err = s.credential(ctx, r["owner"], provider)
	} else {
		token, err = s.boundToken(ctx, r["owner"], obj(r["githubAccess"]), str(source["repositoryFullName"]))
	}
	if err != nil {
		return nil, err
	}
	var endpoint string
	if kind == "gist" {
		endpoint = "/gists/" + segment(str(source["gistId"]))
	} else {
		endpoint = fmt.Sprintf("/repos/%s/pulls/%d", str(source["repositoryFullName"]), number(source["pullRequestId"]))
	}
	upstream, err := s.githubObject(ctx, "GET", endpoint, token, nil)
	if err != nil {
		return nil, err
	}
	if kind == "gist" {
		files := []M{}
		for _, value := range obj(upstream["files"]) {
			f := obj(value)
			if str(f["encoding"]) == "base64" {
				decoded, e := base64.StdEncoding.DecodeString(str(f["content"]))
				if e != nil {
					return nil, fail("github_invalid_response", 502)
				}
				f["content"] = string(decoded)
			}
			if boolean(f["truncated"]) {
				value, e := s.githubText(ctx, str(f["raw_url"]), token, "text/plain", 8*1024*1024)
				if e != nil {
					return nil, e
				}
				f["content"] = value
			}
			files = append(files, selectFields(f, "filename", "content", "language", "size", "type"))
		}
		payload = M{"description": upstream["description"], "isPublic": upstream["public"], "creationDate": date(upstream["created_at"]), "updatedDate": date(upstream["updated_at"]), "ownerLogin": obj(upstream["owner"])["login"], "files": files}
	} else {
		diff, e := s.githubText(ctx, "https://api.github.com"+endpoint, token, "application/vnd.github.diff", 8*1024*1024)
		if e != nil {
			return nil, e
		}
		payload = M{"title": upstream["title"], "body": upstream["body"], "creationDate": date(upstream["created_at"]), "updatedDate": date(upstream["updated_at"]), "draft": upstream["draft"], "merged": upstream["merged"], "mergedDate": date(upstream["merged_at"]), "state": upstream["state"], "baseRepositoryFullName": obj(obj(upstream["base"])["repo"])["full_name"], "headRepositoryFullName": obj(obj(upstream["head"])["repo"])["full_name"], "diff": diff}
	}
	comments := []M{}
	commentsPath := endpoint + "/comments"
	if kind == "pr" {
		commentsPath = fmt.Sprintf("/repos/%s/issues/%d/comments", str(source["repositoryFullName"]), number(source["pullRequestId"]))
	}
	err = s.githubPages(ctx, commentsPath, token, "", func(c M) bool {
		comments = append(comments, M{"body": c["body"], "author": obj(c["user"])["login"], "creationDate": date(c["created_at"]), "updatedDate": date(c["updated_at"])})
		return false
	})
	if err != nil {
		return nil, err
	}
	payload["comments"] = comments
	return payload, nil
}

func (g *githubProvider) ConnectDocument(ctx context.Context, q provider.DocumentRequest, connection string) (provider.Access, error) {
	if q.Kind == "gist" {
		if q.ID == "" {
			return q.Access, fail("gist_not_found", 400)
		}
		return q.Access, nil
	}
	if q.Kind != "pr" || !safeRepositoryName(q.Access.Ref.Name) || q.Number <= 0 {
		return q.Access, fail("pull_request_not_found", 400)
	}
	if len(q.Access.Binding) > 0 {
		return q.Access, g.Authorize(ctx, q.Access)
	}
	c, e := g.Connect(ctx, provider.ConnectRequest{OwnerID: q.Access.OwnerID, Name: q.Access.Ref.Name, Connection: connection})
	q.Access.Binding = c.Binding
	return q.Access, e
}
