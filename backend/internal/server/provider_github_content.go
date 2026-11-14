package server

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

var _ provider.ContentVerifier = (*githubProvider)(nil)
var gitBlobSHA = regexp.MustCompile(`^[a-f0-9]{40}$`)
var lfsOID = regexp.MustCompile(`^oid sha256:([a-f0-9]{64})$`)
var lfsSize = regexp.MustCompile(`^size ([0-9]+)$`)

func (g *githubProvider) VerifyContent(ctx context.Context, a provider.Access, entry provider.Entry, proof provider.ContentProof) (string, error) {
	return verifyGitHubContent(ctx, entry.Revision, proof, func(ctx context.Context) (io.ReadCloser, error) {
		if !safeRepositoryName(a.Ref.Name) {
			return nil, fail("repo_not_found", 404)
		}
		token, err := g.token(ctx, a)
		if err != nil {
			return nil, err
		}
		name := a.Ref.Name
		if entry.Origin != nil {
			if !validFileOrigin(entry.Origin) {
				return nil, fail("invalid_source", 400)
			}
			name, token = entry.Origin.Repository, ""
		}
		return g.server.githubPointer(ctx, name, entry.Revision, token)
	})
}

// Read the Git object itself, never the resolved raw/LFS fallback. A payload
// hash mismatch is only valid if this authenticated pointer proves its identity.
func (s *Server) githubPointer(ctx context.Context, name, revision, token string) (io.ReadCloser, error) {
	if !safeRepositoryName(name) || !gitBlobSHA.MatchString(revision) {
		return nil, fail("invalid_blob_hash", 502)
	}
	if err := s.checkGitHubQuota(ctx, token); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+name+"/git/blobs/"+revision, nil)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/vnd.github.raw+json")
	req.Header.Set("User-Agent", "Anonymous-GitHub")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	client := *s.HTTP
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, context.Cause(ctx)
		}
		return nil, fail("github_unavailable", 502)
	}
	if githubLimited(response) {
		response.Body.Close()
		return nil, s.recordGitHubQuota(ctx, token, response.Header)
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, fail("file_not_available", 502)
	}
	if response.ContentLength > 1024 {
		response.Body.Close()
		return nil, fail("invalid_lfs_pointer", 502)
	}
	return response.Body, nil
}

func verifyGitHubContent(ctx context.Context, revision string, proof provider.ContentProof, pointer func(context.Context) (io.ReadCloser, error)) (string, error) {
	if ctx.Err() != nil {
		return "", context.Cause(ctx)
	}
	if !gitBlobSHA.MatchString(revision) || proof.Size < 0 {
		return "", fail("invalid_blob_hash", 502)
	}
	if proof.GitSHA == revision {
		return "git-" + proof.GitSHA, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, err := pointer(ctx)
	if err != nil {
		return "", err
	}
	if body == nil {
		return "", fail("invalid_lfs_pointer", 502)
	}
	var closed sync.Once
	closeBody := func() { closed.Do(func() { body.Close() }) }
	stop := context.AfterFunc(ctx, closeBody)
	defer stop()
	defer closeBody()
	raw, err := io.ReadAll(io.LimitReader(body, 1025))
	if ctx.Err() != nil {
		return "", context.Cause(ctx)
	}
	if err != nil {
		return "", err
	}
	if len(raw) > 1024 {
		return "", fail("invalid_lfs_pointer", 502)
	}
	hash := sha1.New()
	fmt.Fprintf(hash, "blob %d\x00", len(raw))
	hash.Write(raw)
	text := string(raw)
	// JavaScript multiline anchors recognize CR, LF, U+2028 and U+2029.
	// Preserve first-match behavior for duplicate fields as in TypeScript.
	var oid, size []string
	for _, line := range strings.FieldsFunc(text, func(r rune) bool { return r == '\r' || r == '\n' || r == '\u2028' || r == '\u2029' }) {
		if oid == nil {
			oid = lfsOID.FindStringSubmatch(line)
		}
		if size == nil {
			size = lfsSize.FindStringSubmatch(line)
		}
	}
	if hex.EncodeToString(hash.Sum(nil)) != revision || !strings.HasPrefix(text, "version https://git-lfs.github.com/spec/v1\n") || len(oid) != 2 || len(size) != 2 || oid[1] != proof.SHA256 {
		return "", fail("invalid_blob_hash", 502)
	}
	bytes, err := strconv.ParseInt(size[1], 10, 64)
	if err != nil || bytes != proof.Size {
		return "", fail("invalid_blob_hash", 502)
	}
	return "sha256-" + proof.SHA256, nil
}

func (g *githubProvider) ContentCacheKey(_ provider.Access, entry provider.Entry) string {
	if gitBlobSHA.MatchString(entry.Revision) {
		return "git-" + entry.Revision
	}
	return ""
}
