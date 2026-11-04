package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"path/filepath"
	"sync"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

func (s *Server) startSharedCache() error {
	if !s.Config.SharedCacheEnabled || s.Config.Storage != "filesystem" {
		return nil
	}
	options := s.Config.SharedCache
	options.Root = filepath.Join(options.Root, "source")
	options.Name = "source"
	options.Stage = func(ctx context.Context, name string, elapsed time.Duration, err error) {
		if observe := s.stageObserver(ctx); observe != nil {
			if errors.Is(err, errResultUnchanged) {
				err = nil
			}
			observe(name, elapsed, err)
		}
	}
	options.Observe = func(event blobcache.Event) {
		s.observeCache(event.Context, event.Name, event.Bytes, event.Duration)
	}
	cache, err := blobcache.New(context.Background(), options)
	if err != nil {
		return err
	}
	s.sourceCache = cache
	if s.Config.SharedCacheDecisions {
		resultOptions := options
		resultOptions.Root = filepath.Join(s.Config.SharedCache.Root, "results")
		resultOptions.Name = "result"
		resultOptions.Budget = s.Config.SharedResultBytes
		resultOptions.MaxObject = min(options.MaxObject, s.Config.SharedResultBytes/8)
		// TypeScript uses the default 10% saving and 90% low-water for results.
		resultOptions.Saving = nil
		resultOptions.LowWater = nil
		s.resultCache, err = blobcache.New(context.Background(), resultOptions)
		if err != nil {
			return err
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.sharedCacheCancel = cancel
	s.sharedCacheDone = make(chan struct{})
	go func() {
		defer close(s.sharedCacheDone)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			for _, store := range []*blobcache.Cache{s.sourceCache, s.resultCache} {
				if store == nil {
					continue
				}
				work, stop := context.WithTimeout(ctx, 30*time.Second)
				err := store.Maintain(work)
				stop()
				if err != nil && ctx.Err() == nil {
					name := "source_error"
					if store == s.resultCache {
						name = "result_error"
					}
					s.observeCache(ctx, name, 0, 0)
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return nil
}

func sharedSourceKey(r M, p provider.Repositories, a provider.Access, entry provider.Entry) string {
	if identity, ok := p.(provider.ContentIdentity); ok {
		if key := identity.ContentCacheKey(a, entry); key != "" {
			return key
		}
	}
	// Opaque revisions need repository, path and lifecycle namespaces. Only a
	// provider that can prove a global content identity may share keys globally.
	hash := sha256.Sum256([]byte(rawCachePath(r, a, entry)))
	return "provider-" + hex.EncodeToString(hash[:])
}

func (s *Server) sharedSource(ctx context.Context, r M, p provider.Repositories, a provider.Access, entry provider.Entry) (io.ReadCloser, error) {
	return s.sharedSourceRead(ctx, r, p, a, entry, false)
}

// Internal transform consumers authorize their final output before release.
// Producers still authorize before fetching; raw callers retain release checks.
func (s *Server) sharedSourceRead(ctx context.Context, r M, p provider.Repositories, a provider.Access, entry provider.Entry, internalTransform bool) (result io.ReadCloser, resultErr error) {
	started := time.Now()
	defer func() {
		if resultErr != nil {
			s.observeCache(ctx, "source_error", 0, time.Since(started))
		}
	}()
	check := func(ctx context.Context) error {
		if err := s.activeContentCache(ctx, r); err != nil {
			return err
		}
		return s.authorizeMeasured(ctx, p, a)
	}
	// Lookup does not expose cached bytes. Producers authorize before reading
	// upstream/legacy data, and every reader authorizes at release below,
	// after any cache wait. Avoid an extra upstream check before lookup.
	if err := s.activeContentCache(ctx, r); err != nil {
		return nil, err
	}
	download := func(ctx context.Context) (io.ReadCloser, error) {
		if err := check(ctx); err != nil {
			return nil, err
		}
		body, err := s.openMeasuredSource(ctx, p, a, entry)
		if err != nil {
			return nil, err
		}
		return &bufferedBody{Reader: &cacheLimitReader{reader: body, remaining: anonymize.MaxInput}, Closer: body}, nil
	}
	verify := blobcache.Verifier(func(_ context.Context, proof blobcache.Proof) (string, error) {
		if proof.Size < entry.Size {
			return "", fail("storage_write_size_mismatch", 502)
		}
		return "sha256-" + proof.SHA256, nil
	})
	if verifier, ok := p.(provider.ContentVerifier); ok {
		verify = func(ctx context.Context, proof blobcache.Proof) (string, error) {
			return verifier.VerifyContent(ctx, a, entry, provider.ContentProof{GitSHA: proof.GitSHA, SHA256: proof.SHA256, Size: proof.Size})
		}
	}
	_, canVerify := p.(provider.ContentVerifier)
	allowLegacy, legacy := canVerify, false
	produce := func(ctx context.Context) (io.ReadCloser, error) {
		legacy = false
		if allowLegacy {
			for _, name := range legacySourcePaths(r, a, entry) {
				size, err := s.content.Size(ctx, str(r["repoId"]), name)
				if err != nil || size < entry.Size || size > anonymize.MaxInput {
					continue
				}
				// Recheck after cache coordination before opening legacy bytes.
				// Upstream downloads perform this same check in download.
				if err := check(ctx); err != nil {
					return nil, err
				}
				body, err := s.content.Read(ctx, str(r["repoId"]), name)
				if err != nil {
					continue
				}
				legacy = true
				s.observeCache(ctx, "source_legacy_promotion", size, 0)
				return &bufferedBody{Reader: &cacheLimitReader{reader: body, remaining: anonymize.MaxInput}, Closer: body}, nil
			}
		}
		return download(ctx)
	}
	reader, err := s.sourceCache.GetOrFill(ctx, sharedSourceKey(r, p, a, entry), produce, verify, &entry.Size)
	var admission *blobcache.AdmissionError
	if err != nil && legacy && !errors.As(err, &admission) && ctx.Err() == nil {
		allowLegacy = false
		reader, err = s.sourceCache.GetOrFill(ctx, sharedSourceKey(r, p, a, entry), produce, verify, &entry.Size)
	}
	if err != nil {
		var admission *blobcache.AdmissionError
		if !errors.As(err, &admission) {
			return nil, err
		}
		s.observeCache(ctx, "source_bypass", entry.Size, 0)
		// Admission is an optimization decision, not a failed content request.
		// Keep upstream reads bounded even when no cache space is available.
		work, cancel := context.WithTimeout(ctx, 120*time.Second)
		body, err := download(work)
		if err != nil {
			cancel()
			return nil, err
		}
		if err = check(work); err != nil {
			body.Close()
			cancel()
			return nil, err
		}
		// Match the minimum-size rule used by the generic fill verifier even
		// when disk/object admission bypasses it. Provider-specific verifiers
		// can interpret sizes differently, for example a Git LFS pointer size.
		if !canVerify {
			body = checkedBody(body, entry.Size)
		}
		bounded := &sharedFallback{body: body, reader: cacheLimitReader{reader: body, remaining: anonymize.MaxInput}, ctx: work, cancel: cancel}
		context.AfterFunc(work, func() { bounded.Close() })
		return bounded, nil
	}
	if reader.Record().Size > anonymize.MaxInput {
		reader.Close()
		return nil, fail("file_too_big", 413)
	}
	var releaseErr error
	if internalTransform {
		releaseErr = s.activeContentCache(ctx, r)
	} else {
		releaseErr = check(ctx)
	}
	if err = releaseErr; err != nil {
		reader.Close()
		return nil, err
	}
	return reader, nil
}

type sharedFallback struct {
	body     io.ReadCloser
	reader   cacheLimitReader
	ctx      context.Context
	cancel   context.CancelFunc
	once     sync.Once
	terminal error
}

func (r *sharedFallback) Close() error { r.once.Do(func() { r.cancel(); r.body.Close() }); return nil }
func (r *sharedFallback) Read(p []byte) (int, error) {
	// Peek may consume a terminal error while retaining buffered bytes. Keep
	// EOF/read failures stable after Close cancels the download context.
	if r.terminal != nil {
		return 0, r.terminal
	}
	if r.ctx.Err() != nil {
		return 0, context.Cause(r.ctx)
	}
	n, err := r.reader.Read(p)
	if r.ctx.Err() != nil {
		err = context.Cause(r.ctx)
	}
	if err != nil {
		r.terminal = err
		r.Close()
	}
	return n, err
}
