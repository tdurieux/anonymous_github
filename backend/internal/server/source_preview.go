package server

import (
	"context"
	"encoding/base64"
	"errors"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/tdurieux/anonymous_github/backend/internal/filetype"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

var previewCommit = regexp.MustCompile(`^[0-9a-fA-F]{6,40}$`)

func safeSourcePath(value string) bool {
	if value == "" || len(value) > 4096 || strings.Contains(value, "\\") {
		return false
	}
	for _, c := range value {
		if c < 32 {
			return false
		}
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
func (s *Server) sourcePreview(q *request) (any, error) {
	query := parseExtendedQuery(q.R.URL.RawQuery).object
	commit, ok := query["commit"].scalarValue()
	id := q.Params["provider"]
	if id == "" {
		id = "github"
	}
	validCommit := commit != "" && len(commit) <= 512 && !strings.ContainsAny(commit, "\r\n\x00")
	if id == "github" {
		validCommit = previewCommit.MatchString(commit)
	}
	if !ok || !validCommit {
		return nil, fail("invalid_commit_format", 400)
	}
	isFile := strings.HasSuffix(q.R.URL.Path, "/file")
	path, _ := query["path"].scalarValue()
	if isFile && !safeSourcePath(path) {
		return nil, fail("invalid_path", 400)
	}
	adapter, err := s.providers.Get(id)
	if err != nil {
		return nil, providerFailure(err)
	}
	repositories, ok := adapter.(provider.Repositories)
	if !ok {
		return nil, providerFailure(provider.ErrCapability)
	}
	previews, ok := adapter.(provider.SourcePreviews)
	if !ok {
		return nil, providerFailure(provider.ErrCapability)
	}
	name := q.Params["owner"] + "/" + q.Params["repo"]
	if q.Params["provider"] != "" {
		name, _ = query["repository"].scalarValue()
	}
	access, err := s.previewRepositoryAccess(q, repositories, id, name)
	if err != nil {
		return nil, err
	}
	if err = repositories.Authorize(q.ctx(), access); err != nil {
		return nil, err
	}
	access.Ref.Commit = commit
	q.W.Header().Set("Cache-Control", "private, no-store")
	if !isFile {
		entries, truncated, err := previews.PreviewTree(q.ctx(), access, 20000)
		if err != nil {
			return nil, err
		}
		files, binaryFiles := []string{}, []string{}
		for _, entry := range entries {
			if entry.Directory || entry.Path == ".gitmodules" || !safeSourcePath(entry.Path) {
				continue
			}
			text, known := filetype.ClassifyName(entry.Path)
			if known && !text {
				binaryFiles = append(binaryFiles, entry.Path)
			} else {
				files = append(files, entry.Path)
			}
		}
		sort.Strings(files)
		sort.Strings(binaryFiles)
		return M{"files": files, "binaryFiles": binaryFiles, "truncated": truncated}, nil
	}
	content, size, binary, err := previews.PreviewFile(q.ctx(), access, path, 1024*1024)
	if err != nil {
		return nil, err
	}
	q.W.Header().Set("X-Content-Type-Options", "nosniff")
	if binary {
		return M{"binary": true, "size": size}, nil
	}
	return q.text(strings.ToValidUTF8(string(content), "\uFFFD")), nil
}
func sourcePreviewError(err error, file bool) error {
	var upstream *githubHTTPError
	if errors.As(err, &upstream) && (upstream.status == 404 || upstream.status == 422 || (!file && upstream.status == 409)) {
		if file {
			return fail("file_not_found", 404)
		}
		return fail("repo_not_found", 404)
	}
	return err
}
func (g *githubProvider) PreviewTree(ctx context.Context, a provider.Access, limit int) ([]provider.Entry, bool, error) {
	token, err := g.token(ctx, a)
	if err != nil {
		return nil, false, err
	}
	commit := a.Ref.Commit
	if len(commit) != 40 {
		row, e := g.server.githubObject(ctx, "GET", "/repos/"+a.Ref.Name+"/commits/"+segment(commit), token, nil)
		if e != nil {
			return nil, false, sourcePreviewError(e, false)
		}
		commit = str(row["sha"])
		if len(commit) != 40 || !previewCommit.MatchString(commit) {
			return nil, false, fail("invalid_source", 502)
		}
	}
	row, err := g.server.githubObject(ctx, "GET", "/repos/"+a.Ref.Name+"/git/trees/"+segment(commit)+"?recursive=true", token, nil)
	if err != nil {
		return nil, false, sourcePreviewError(err, false)
	}
	entries := []provider.Entry{}
	for _, raw := range arr(row["tree"]) {
		entry := obj(raw)
		p := str(entry["path"])
		if entry["type"] != "blob" || p == ".gitmodules" || !safeSourcePath(p) {
			continue
		}
		if len(entries) == limit {
			return entries, true, nil
		}
		entries = append(entries, provider.Entry{Path: p, Revision: str(entry["sha"]), Size: number(entry["size"])})
	}
	return entries, boolean(row["truncated"]), nil
}
func (g *githubProvider) PreviewFile(ctx context.Context, a provider.Access, path string, limit int64) ([]byte, int64, bool, error) {
	token, err := g.token(ctx, a)
	if err != nil {
		return nil, 0, false, err
	}
	parts := strings.Split(path, "/")
	for i := range parts {
		parts[i] = segment(parts[i])
	}
	row, err := g.server.githubObject(ctx, "GET", "/repos/"+a.Ref.Name+"/contents/"+strings.Join(parts, "/")+"?ref="+url.QueryEscape(a.Ref.Commit), token, nil)
	if err != nil {
		return nil, 0, false, sourcePreviewError(err, true)
	}
	if row["type"] != "file" {
		return nil, 0, false, fail("file_not_found", 404)
	}
	size := number(row["size"])
	if text, known := filetype.ClassifyName(path); known && !text {
		return nil, size, true, nil
	}
	if size > limit || (size > 0 && row["encoding"] == "none") {
		return nil, 0, false, fail("file_too_big", 413)
	}
	content := []byte(str(row["content"]))
	if row["encoding"] == "base64" {
		content, err = base64.StdEncoding.DecodeString(strings.ReplaceAll(str(row["content"]), "\n", ""))
		if err != nil {
			return nil, 0, false, fail("invalid_source", 502)
		}
	}
	if int64(len(content)) > limit {
		return nil, 0, false, fail("file_too_big", 413)
	}
	return content, size, len(content) > 0 && !filetype.Text(path, content), nil
}
