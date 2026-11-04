package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"path"
	"sync"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
)

var errResultUnchanged = errors.New("shared_result_unchanged")

// The additional sourceURLs field captures provider-specific rewrite rules.
// It deliberately separates these decisions from older Node decisions that do
// not describe those rules. Payloads still use the shared content digest format.
func (s *Server) sharedResultKey(r, row M, digest string, opt anonymize.Options) (string, error) {
	options := struct {
		FilePath   string   `json:"filePath"`
		Generation string   `json:"cacheGeneration"`
		Terms      []string `json:"terms"`
		Revision   any      `json:"cacheRevision,omitempty"`
		Image      *bool    `json:"image,omitempty"`
		Link       *bool    `json:"link,omitempty"`
		RepoID     string   `json:"repoId"`
		RepoName   string   `json:"repoName"`
		BranchName string   `json:"branchName"`
		SourceURLs []string `json:"sourceURLs"`
	}{path.Join(str(row["path"]), str(row["name"])), contentGeneration(r), opt.Terms, r["contentCacheRevision"], opt.Image, opt.Link, opt.RepoID, opt.RepoName, opt.BranchName, opt.SourceURLs}
	var data bytes.Buffer
	encoder := json.NewEncoder(&data)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode([]any{"anonymizer-v2", digest, options, s.Config.Mask, s.Config.Hostname, []string{"license", "dockerfile", "sbt", "ipynb", "gp", "out", "sol", "in", "jsonl", "ndjson"}}); err != nil {
		return "", err
	}
	sum := sha256.Sum256(jsonSeparators(bytes.TrimSuffix(data.Bytes(), []byte("\n"))))
	return hex.EncodeToString(sum[:]), nil
}

// A false handled result leaves the original buffered source untouched so the
// caller can use its existing transform path after cache admission failure.
func (s *Server) sharedResult(ctx context.Context, r, row M, source *blobcache.Reader, isText bool, opt anonymize.Options) (output *blobcache.Reader, handled bool, err error) {
	record := source.Record()
	key, err := s.sharedResultKey(r, row, record.Digest, opt)
	if err != nil {
		return nil, true, err
	}
	check := func() error {
		if err := s.activeContentCache(ctx, r); err != nil {
			return err
		}
		_, err := s.authorizeContent(ctx, r)
		return err
	}
	// The source reader was authorized on release by sharedSource. Keep the
	// local lifecycle fence here, then reauthorize the result after lookup or
	// transformation, immediately before returning it to the caller.
	if err = s.activeContentCache(ctx, r); err != nil {
		return nil, true, err
	}
	defer func() {
		if err == nil && output != nil {
			if err = check(); err != nil {
				output.Close()
				output = nil
			}
		}
	}()
	lookupDone := s.startStage(ctx, "cache_lookup")
	decision, err := s.resultCache.Decision(ctx, key)
	lookupDone(err)
	if err != nil {
		return nil, true, err
	}
	if decision != nil {
		store := s.resultCache
		if !decision.Changed {
			store = s.sourceCache
		}
		output, err = store.Open(ctx, decision.Digest, false)
		if err != nil {
			return nil, true, err
		}
		if output != nil {
			s.observeCache(ctx, "decision_hit", record.Size, 0)
			name := "rewrite_unchanged_cached"
			if decision.Changed {
				name = "rewrite_changed_cached"
			}
			s.observeCache(ctx, name, record.Size, 0)
			return output, true, nil
		}
	}
	s.observeCache(ctx, "decision_miss", record.Size, 0)
	if !isText {
		if err = s.resultCache.SaveDecision(ctx, key, record.Digest, false); err != nil {
			return nil, true, err
		}
		s.observeCache(ctx, "rewrite_binary", record.Size, 0)
		output, err = s.sourceCache.Open(ctx, record.Digest, false)
		return output, output != nil || err != nil, err
	}
	started := time.Now()
	produce := func(work context.Context) (io.ReadCloser, error) {
		input, err := s.sourceCache.Open(work, record.Digest, false)
		if err != nil {
			return nil, err
		}
		if input == nil {
			return nil, &blobcache.AdmissionError{Code: "source_evicted"}
		}
		defer input.Close()
		file, _, cleanup, err := s.pool.Process(work, input, anonymize.ProcessRequest{StageEvent: s.stageObserver(ctx), Options: opt, Context: anonymize.Context{Mask: s.Config.Mask, Hostname: s.Config.Hostname}, MaxOutput: anonymize.MaxOutput})
		if err != nil {
			return nil, transformFailure(err)
		}
		return &resultFile{Reader: file, cleanup: cleanup}, nil
	}
	verify := func(work context.Context, proof blobcache.Proof) (string, error) {
		unchanged := record.Digest == "git-"+proof.GitSHA || record.Digest == "sha256-"+proof.SHA256
		name := "rewrite_changed"
		if unchanged {
			name = "rewrite_unchanged"
		}
		s.observeCache(work, name, record.Size, time.Since(started))
		if unchanged {
			if err := s.resultCache.SaveDecision(work, key, record.Digest, false); err != nil {
				return "", err
			}
			return "", errResultUnchanged
		}
		return "sha256-" + proof.SHA256, nil
	}
	output, err = s.resultCache.GetOrFill(ctx, "render-"+key, produce, verify, &record.Size)
	if errors.Is(err, errResultUnchanged) {
		output, err = s.sourceCache.Open(ctx, record.Digest, false)
		return output, output != nil || err != nil, err
	}
	if err != nil {
		var admission *blobcache.AdmissionError
		if errors.As(err, &admission) {
			s.observeCache(ctx, "decision_bypass", record.Size, 0)
			return nil, false, nil
		}
		return nil, true, err
	}
	if err = s.resultCache.SaveDecision(ctx, key, output.Record().Digest, true); err != nil {
		output.Close()
		return nil, true, err
	}
	return output, true, nil
}

type resultFile struct {
	io.Reader
	cleanup func()
	once    sync.Once
}

func (f *resultFile) Close() error { f.once.Do(f.cleanup); return nil }
