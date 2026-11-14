package server

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type requestTrace struct {
	id     string
	logger *slog.Logger
	mu     sync.Mutex
	stages map[string]float64
}

func newRequestTrace() *requestTrace {
	return &requestTrace{id: uuid.NewString(), logger: slog.Default(), stages: map[string]float64{}}
}
func traceFrom(ctx context.Context) *requestTrace {
	trace, _ := ctx.Value(performanceContextKey{}).(*requestTrace)
	return trace
}
func (t *requestTrace) observe(name string, elapsed time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.stages[name] += math.Max(0, float64(elapsed)/float64(time.Millisecond))
}
func (t *requestTrace) log(r *http.Request, state *responseState, route, method string, started time.Time, elapsed time.Duration, bytes int64, aborted, slow bool) M {
	if t == nil || t.logger == nil {
		return nil
	}
	t.mu.Lock()
	stages := make(map[string]float64, len(t.stages))
	for k, v := range t.stages {
		stages[k] = v
	}
	t.mu.Unlock()
	var firstByte any
	if !state.firstWrite.IsZero() {
		firstByte = math.Max(0, float64(state.firstWrite.Sub(started))/float64(time.Millisecond))
	}
	status := state.status
	if status == 0 {
		status = http.StatusOK
	}
	outcome := "completed"
	if aborted {
		outcome = "interrupted"
	}
	fields := []any{"requestId", t.id, "service", "api", "method", method, "route", route, "status", status, "outcome", outcome, "ms", math.Round(float64(elapsed) / float64(time.Millisecond)), "firstByteMs", firstByte, "bytes", bytes, "stages", stages}
	switch {
	case aborted:
		t.logger.WarnContext(r.Context(), "request interrupted", fields...)
	case slow:
		t.logger.WarnContext(r.Context(), "slow request", fields...)
	case !strings.Contains(route, "healthcheck"):
		t.logger.InfoContext(r.Context(), "request", fields...)
	}
	if aborted || slow {
		return M{"requestId": t.id, "service": "api", "method": method, "route": route, "status": status, "outcome": outcome, "ms": math.Round(float64(elapsed) / float64(time.Millisecond)), "firstByteMs": firstByte, "bytes": bytes, "stages": stages}
	}
	return nil

}
