package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"strings"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
)

func rawCachePath(r M, a provider.Access, entry provider.Entry) string {
	identity, _ := json.Marshal([]any{"go-raw-v1", a.Ref.Provider, a.Ref.ID, a.Ref.Commit, entry.Revision, r["contentCacheRevision"]})
	digest := sha256.Sum256(identity)
	return contentPrefix(r) + "/" + hex.EncodeToString(digest[:]) + "/" + entry.Path
}

func contentRevisionFilter(r M) M {
	filter := revisionFilter(r)
	// Cache-presence bookkeeping changes statusDate without changing content.
	// Status, generation, settings, grant and cache revisions fence publication.
	delete(filter, "statusDate")
	for _, field := range []string{"anonymizeDate", "contentCacheRevision"} {
		if value, ok := r[field]; ok {
			filter[field] = value
		} else {
			filter[field] = M{"$exists": false}
		}
	}
	return filter
}

func (s *Server) activeContentCache(ctx context.Context, r M) error {
	filter := contentRevisionFilter(r)
	current, err := s.Store.one(ctx, collection("repo"), filter)
	if err != nil {
		return err
	}
	if current == nil {
		return fail("repository_changed", 409)
	}
	switch str(current["status"]) {
	case "expiring", "expired", "removing", "removed", "archived":
		return fail("repository_changed", 409)
	}
	marker := "__content/__retired/" + strings.TrimPrefix(contentPrefix(r), "__content/") + ".txt"
	_, err = s.content.Size(ctx, str(r["repoId"]), marker)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return fail("repository_changed", 409)
}

func (s *Server) cachedBlob(ctx context.Context, r M, p provider.Repositories, a provider.Access, entry provider.Entry) (result io.ReadCloser, resultErr error) {
	// Archive originals are authoritative data, not an upstream cache.
	if a.Ref.Provider == "archive" {
		return s.openMeasuredSource(ctx, p, a, entry)
	}
	if _, err := security.RelativePath(entry.Path); err != nil {
		return nil, fail("invalid_path", 400)
	}
	if s.sourceCache != nil {
		return s.sharedSource(ctx, r, p, a, entry)
	}
	started := time.Now()
	defer func() {
		if resultErr != nil {
			s.observeCache(ctx, "source_error", 0, time.Since(started))
		}
	}()
	requestContext := ctx
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	// This deadline covers filling, not the caller's subsequent read.
	defer cancel()
	id, cachePath := str(r["repoId"]), rawCachePath(r, a, entry)
	hit := func() bool {
		size, err := s.content.Size(ctx, id, cachePath)
		return err == nil && size >= entry.Size && size <= anonymize.MaxInput
	}
	open := func() (io.ReadCloser, error) {
		if err := s.activeContentCache(ctx, r); err != nil {
			return nil, err
		}
		if err := s.authorizeMeasured(ctx, p, a); err != nil {
			return nil, err
		}
		// Use the original request context for the returned S3 stream.
		return s.content.Read(requestContext, id, cachePath)
	}
	if err := s.activeContentCache(ctx, r); err != nil {
		return nil, err
	}
	if hit() {
		result, resultErr = open()
		if resultErr == nil {
			s.observeCache(ctx, "legacy_source_hit", entry.Size, 0)
		}
		return result, resultErr
	}
	s.observeCache(ctx, "legacy_source_miss", entry.Size, 0)
	if s.cacheFills.Add(1) > 64 {
		s.cacheFills.Add(-1)
		s.observeCache(ctx, "source_bypass", entry.Size, 0)
		return nil, fail("cache_busy", 503)
	}
	defer s.cacheFills.Add(-1)
	digest := sha256.Sum256([]byte(id + ":" + cachePath))
	lock := "go:content-fill:" + hex.EncodeToString(digest[:])
	token, err := security.RandomToken()
	if err != nil {
		return nil, err
	}
	waited := false
	for {
		if hit() {
			return open()
		}
		acquired, lockErr := s.Store.Redis.SetNX(ctx, lock, token, 125*time.Second).Result()
		// Coordination is optional, as in TypeScript. Atomic storage publication and
		// generation checks remain mandatory when Redis is unavailable.
		if lockErr != nil || acquired {
			if acquired {
				defer func() {
					cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
					defer stop()
					s.Store.Redis.Eval(cleanup, `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end;return 0`, []string{lock}, token)
				}()
			}
			break
		}
		if !waited {
			s.observeCache(ctx, "source_fill_wait", 0, 0)
			waited = true
		}
		select {
		case <-ctx.Done():
			return nil, fail("cache_busy", 503)
		case <-time.After(100 * time.Millisecond):
		}
	}
	// A prior leader may have published between the lookup and lock acquisition.
	if hit() {
		return open()
	}
	if err := s.activeContentCache(ctx, r); err != nil {
		return nil, err
	}
	if err := s.authorizeMeasured(ctx, p, a); err != nil {
		return nil, err
	}
	body, err := s.openMeasuredSource(ctx, p, a, entry)
	if err != nil {
		return nil, err
	}
	limited := &cacheLimitReader{reader: body, remaining: anonymize.MaxInput}
	err = s.content.Put(ctx, id, cachePath, limited, entry.Size, anonymize.MaxInput)
	body.Close()
	if err != nil {
		if err.Error() == "storage_write_size_mismatch" {
			return nil, fail("storage_write_size_mismatch", 502)
		}
		return nil, err
	}
	if err = s.activeContentCache(ctx, r); err != nil {
		cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		if removeErr := s.content.Remove(cleanup, id, cachePath); removeErr != nil {
			return nil, removeErr
		}
		return nil, err
	}
	storedBytes := anonymize.MaxInput - limited.remaining
	s.observeCache(ctx, "source_fill", storedBytes, time.Since(started))
	s.observeCache(ctx, "source_stored", storedBytes, 0)
	return open()
}

// Fence in-flight fills before deleting cached bytes. Archived storage is kept
// for the separate resumable archive cleanup workflow.
func (s *Server) resetContentCache(ctx context.Context, r M) error {
	if s.pool != nil {
		s.pool.RemoveResults(str(r["repoId"]))
	}
	if str(r["status"]) == "archived" {
		return nil
	}
	entries, err := s.content.List(ctx, str(r["repoId"]))
	if err != nil {
		return err
	}
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		paths = append(paths, entry.Path)
	}
	revision, err := security.RandomToken()
	if err != nil {
		return err
	}
	changed, err := s.Store.update(ctx, collection("repo"), revisionFilter(r), M{"$set": M{"contentCacheRevision": revision, "isReseted": true, "size": M{"storage": 0, "file": 0}}, "$unset": M{"sizeComputedAt": ""}})
	if err != nil {
		return err
	}
	if !changed {
		return fail("repository_changed", 409)
	}
	return s.content.RemoveFiles(ctx, str(r["repoId"]), paths)
}

// Read one byte beyond the limit to distinguish oversized content from EOF.
type cacheLimitReader struct {
	reader    io.Reader
	remaining int64
}

func (r *cacheLimitReader) Read(p []byte) (int, error) {
	if int64(len(p)) > r.remaining+1 {
		p = p[:r.remaining+1]
	}
	n, err := r.reader.Read(p)
	r.remaining -= int64(n)
	if r.remaining < 0 {
		return n, fail("file_too_big", 413)
	}
	return n, err
}

// The caller owns r. Update its snapshot along with the database so subsequent
// file/ZIP publication checks observe this request's status timestamp.
func (s *Server) markCachePresent(ctx context.Context, r M) error {
	if !boolean(r["isReseted"]) {
		return nil
	}
	if str(r["status"]) != "ready" {
		return fail("repository_changed", 409)
	}
	filter := contentRevisionFilter(r)
	filter["isReseted"] = true
	now := time.Now().Truncate(time.Millisecond)
	changed, err := s.Store.update(ctx, collection("repo"), filter, M{"$set": M{"isReseted": false, "statusDate": now}, "$unset": M{"statusMessage": ""}})
	if err != nil {
		return err
	}
	if !changed {
		// Another successful read can have completed the same transition. Accept
		// only that ready, non-reset state with the same source/settings/cache.
		delete(filter, "statusDate")
		filter["isReseted"] = false
		current, err := s.Store.one(ctx, collection("repo"), filter)
		if err != nil {
			return err
		}
		if current == nil {
			return fail("repository_changed", 409)
		}
		now = date(current["statusDate"])
	}
	r["isReseted"], r["statusDate"] = false, now
	delete(r, "statusMessage")
	return nil
}
