package server

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

type performanceContextKey struct{}

// Only fixed operation names from HTTP work enter the bounded metrics buffer.
func (s *Server) stageObserver(ctx context.Context) func(string, time.Duration, error) {
	trace := traceFrom(ctx)
	if trace == nil {
		return nil
	}
	return func(name string, elapsed time.Duration, err error) {
		switch name {
		case "repository", "authorization", "upstream", "cache_lookup", "cache_fill", "worker_wait", "anonymize":
		default:
			return
		}
		trace.observe(name, elapsed)
		if s.requestMetrics == nil {
			return
		}
		key := requestMetricKey{time.Now().UnixMilli() / 60000 * 60000, name, "all", "all"}
		s.requestMetrics.observe(key, elapsed, 0, errors.Is(err, context.Canceled), err != nil, false)
	}
}
func (s *Server) startStage(ctx context.Context, name string) func(error) {
	observe := s.stageObserver(ctx)
	if observe == nil {
		return func(error) {}
	}
	started := time.Now()
	var once sync.Once
	return func(err error) { once.Do(func() { observe(name, time.Since(started), err) }) }
}

// Include body consumption, not only the upstream response headers. EOF and
// Close can both occur; startStage records at most one sample.
type measuredSource struct {
	io.ReadCloser
	done func(error)
}

func (r *measuredSource) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if err == io.EOF {
		r.done(nil)
	} else if err != nil {
		r.done(err)
	}
	return n, err
}
func (r *measuredSource) Close() error {
	err := r.ReadCloser.Close()
	r.done(err)
	return err
}
func (s *Server) openMeasuredSource(ctx context.Context, p provider.Repositories, access provider.Access, entry provider.Entry) (io.ReadCloser, error) {
	done := s.startStage(ctx, "upstream")
	body, err := p.Open(ctx, access, entry)
	if err != nil {
		s.scheduleOwnerAlert(access.OwnerID, access.Ref.AnonymousID, err)
	}
	if err != nil {
		done(err)
		return nil, err
	}
	if s.Config.Billing.Enabled && access.Ref.AnonymousID != "" {
		body = &billingContentReader{ReadCloser: body, s: s, ctx: ctx, repoID: access.Ref.AnonymousID, key: entry.Path, expected: entry.Size}
	}
	return &measuredSource{ReadCloser: body, done: done}, nil
}

func (s *Server) authorizeMeasured(ctx context.Context, p provider.Repositories, access provider.Access) error {
	done := s.startStage(ctx, "authorization")
	err := p.Authorize(ctx, access)
	if err != nil {
		s.scheduleOwnerAlert(access.OwnerID, access.Ref.AnonymousID, err)
	}
	done(err)
	return err
}
