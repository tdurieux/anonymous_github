package server

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
)

var _ provider.Archives = (*githubProvider)(nil)

func (g *githubProvider) OpenArchive(ctx context.Context, a provider.Access) (result provider.Archive, resultErr error) {
	if !safeRepositoryName(a.Ref.Name) || !gitBlobSHA.MatchString(a.Ref.Commit) {
		return nil, fail("invalid_source", 400)
	}
	token, err := g.token(ctx, a)
	if err != nil {
		return nil, err
	}
	if err = g.server.checkGitHubQuota(ctx, token); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/"+a.Ref.Name+"/tarball/"+a.Ref.Commit, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Anonymous-GitHub")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	client := *g.server.HTTP
	// The ordinary API timeout includes the entire body, too short for a
	// backpressured repository stream. Keep a finite deadline for this request.
	client.Timeout = 30 * time.Minute
	client.CheckRedirect = archiveRedirect
	done := g.server.startStage(ctx, "upstream")
	defer func() {
		if resultErr != nil {
			done(resultErr)
		}
	}()
	response, err := client.Do(req)
	if err != nil {
		return nil, fail("github_archive_unavailable", 502)
	}
	if githubLimited(response) {
		response.Body.Close()
		return nil, g.server.recordGitHubQuota(ctx, token, response.Header)
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, fail("github_archive_unavailable", 502)
	}
	return newGitHubArchive(ctx, &measuredSource{ReadCloser: response.Body, done: done})
}

func archiveRedirect(next *http.Request, via []*http.Request) error {
	if len(via) >= 5 || next.URL.Scheme != "https" || next.URL.User != nil || next.URL.Port() != "" ||
		(next.URL.Host != "api.github.com" && next.URL.Host != "codeload.github.com") {
		return errors.New("unsafe_archive_redirect")
	}
	// Codeload receives the signed redirect URL, never the API credential.
	if next.URL.Host != "api.github.com" || len(via) == 0 || via[len(via)-1].URL.Host != "api.github.com" {
		next.Header.Del("Authorization")
	}
	return nil
}

type githubArchive struct {
	stop  func() bool
	ctx   context.Context
	body  io.ReadCloser
	gzip  *gzip.Reader
	tar   *tar.Reader
	root  string
	ended bool
}

func newGitHubArchive(ctx context.Context, body io.ReadCloser) (provider.Archive, error) {
	stop := context.AfterFunc(ctx, func() { body.Close() })
	gz, err := gzip.NewReader(&zipContextReader{ctx: ctx, reader: body})
	if err != nil {
		stop()
		body.Close()
		return nil, err
	}
	return &githubArchive{stop: stop, ctx: ctx, body: body, gzip: gz, tar: tar.NewReader(gz)}, nil
}

func (a *githubArchive) Close() error {
	a.stop()
	a.gzip.Close()
	return a.body.Close()
}

func (a *githubArchive) Next() (provider.Entry, io.Reader, error) {
	for {
		if err := a.ctx.Err(); err != nil {
			return provider.Entry{}, nil, err
		}
		if a.ended {
			return provider.Entry{}, nil, io.EOF
		}
		header, err := a.tar.Next()
		if err == io.EOF {
			// tar EOF precedes gzip's checksum. Consume bounded zero padding and
			// require gzip EOF before allowing the outgoing ZIP to be finalized.
			padding, e := io.ReadAll(io.LimitReader(a.gzip, (1<<20)+1))
			if e != nil {
				return provider.Entry{}, nil, e
			}
			if len(padding) > 1<<20 || strings.Trim(string(padding), "\x00") != "" {
				return provider.Entry{}, nil, errors.New("invalid_archive_trailer")
			}
			a.ended = true
			return provider.Entry{}, nil, io.EOF
		}
		if err != nil {
			return provider.Entry{}, nil, err
		}
		// GitHub starts archives with a global PAX comment containing the
		// commit ID. archive/tar parses and bounds this metadata; it is not
		// a repository entry and must not become the root path.
		if header.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		name := strings.TrimSuffix(header.Name, "/")
		safe, err := security.RelativePath(name)
		if err != nil || safe != name {
			return provider.Entry{}, nil, errors.New("invalid_archive_path")
		}
		root, relative, found := strings.Cut(name, "/")
		if a.root == "" {
			a.root = root
		}
		if root != a.root {
			return provider.Entry{}, nil, errors.New("invalid_archive_root")
		}
		if header.Typeflag == tar.TypeDir {
			continue
		}
		if !found || relative == "" {
			return provider.Entry{}, nil, errors.New("invalid_archive_path")
		}
		entry := provider.Entry{Path: relative, Size: header.Size}
		switch header.Typeflag {
		case tar.TypeReg, tar.TypeRegA:
			if header.Size < 0 {
				return provider.Entry{}, nil, fail("file_too_big", 413)
			}
			return entry, &zipContextReader{ctx: a.ctx, reader: a.tar}, nil
		case tar.TypeSymlink:
			// Git stores a symlink as a blob containing its target. Preserve those
			// bytes as a regular output entry; never resolve or create a link.
			entry.Size = int64(len(header.Linkname))
			if entry.Size > anonymize.MaxInput {
				return provider.Entry{}, nil, fail("file_too_big", 413)
			}
			return entry, strings.NewReader(header.Linkname), nil
		default:
			return provider.Entry{}, nil, errors.New("unsupported_archive_entry")
		}
	}
}

func (g *githubProvider) VerifyArchiveContent(ctx context.Context, a provider.Access, entry provider.Entry, proof provider.ContentProof, prefix []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if proof.GitSHA != entry.Revision || strings.HasPrefix(string(prefix), "version https://git-lfs.github.com/spec/v1\n") {
		return provider.ErrArchiveEntryFallback
	}
	return nil
}
