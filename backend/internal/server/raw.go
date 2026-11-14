package server

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
)

type bufferedBody struct {
	io.Reader
	io.Closer
}

func (s *Server) inspectBlob(ctx context.Context, body io.ReadCloser, r, row M, token string) (io.ReadCloser, error) {
	reader := bufio.NewReader(body)
	prefix, _ := reader.Peek(256)
	if strings.HasPrefix(string(prefix), "version https://git-lfs.github.com/spec/v1\n") {
		body.Close()
		return s.rawBlob(ctx, r, row, token)
	}
	return checkedBody(&bufferedBody{Reader: reader, Closer: body}, number(row["size"])), nil
}
func rawHost(host string) bool {
	return host == "github.com" || host == "raw.githubusercontent.com" || host == "media.githubusercontent.com"
}
func (s *Server) rawBlob(ctx context.Context, r, row M, token string) (io.ReadCloser, error) {
	source := obj(r["source"])
	name, commit := str(source["repositoryName"]), str(source["commit"])
	original := str(row["name"])
	if folder := str(row["path"]); folder != "" {
		original = folder + "/" + original
	}
	if _, e := security.RelativePath(original); e != nil || !safeRepositoryName(name) || !commitID.MatchString(commit) {
		return nil, fail("invalid_source", 400)
	}
	parts := strings.Split(original, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://github.com/"+name+"/raw/"+commit+"/"+strings.Join(parts, "/"), nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("User-Agent", "Anonymous-GitHub")
	client := *s.HTTP
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if len(via) >= 5 || next.URL.Scheme != "https" || next.URL.User != nil || next.URL.Port() != "" || !rawHost(next.URL.Hostname()) {
			return fail("invalid_github_redirect", 502)
		}
		// Never propagate a grant to a CDN, even when GitHub redirects there.
		if next.URL.Host != via[0].URL.Host {
			next.Header.Del("Authorization")
		}
		return nil
	}
	if err := s.checkGitHubQuota(ctx, token); err != nil {
		return nil, err
	}
	response, e := client.Do(req)
	if e != nil {
		return nil, fail("github_unavailable", 502)
	}
	if githubLimited(response) {
		response.Body.Close()
		return nil, s.recordGitHubQuota(ctx, token, response.Header)
	}
	if response.StatusCode != 200 {
		response.Body.Close()
		return nil, fail("file_not_available", 502)
	}
	if response.ContentLength > anonymize.MaxInput {
		response.Body.Close()
		return nil, fail("file_too_big", 413)
	}
	return checkedBody(response.Body, response.ContentLength), nil
}
