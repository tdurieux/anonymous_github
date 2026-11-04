package server

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func TestStageMetricsBoundedAndOnce(t *testing.T) {
	s := &Server{requestMetrics: &requestMetrics{pending: map[requestMetricKey]requestSample{}}}
	s.startStage(context.Background(), "repository")(nil)
	ctx := context.WithValue(context.Background(), performanceContextKey{}, newRequestTrace())
	s.stageObserver(ctx)("secret-repository-name", time.Second, nil)
	if len(s.requestMetrics.pending) != 0 {
		t.Fatal("background or arbitrary label recorded")
	}
	done := s.startStage(ctx, "authorization")
	done(context.Canceled)
	done(nil)
	for key, sample := range s.requestMetrics.pending {
		if key.metric != "authorization" || key.route != "all" || sample.count != 1 || sample.aborted != 1 || sample.errors != 1 {
			t.Fatalf("unexpected sample: %+v %+v", key, sample)
		}
	}
	if len(s.requestMetrics.pending) != 1 {
		t.Fatal("missing sample")
	}
}
func TestStageMetricsStreamEOFAndClose(t *testing.T) {
	s := &Server{requestMetrics: &requestMetrics{pending: map[requestMetricKey]requestSample{}}}
	ctx := context.WithValue(context.Background(), performanceContextKey{}, newRequestTrace())
	r := &measuredSource{ReadCloser: io.NopCloser(strings.NewReader("unchanged output")), done: s.startStage(ctx, "upstream")}
	data, err := io.ReadAll(r)
	if err != nil || string(data) != "unchanged output" {
		t.Fatal(string(data), err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	for _, sample := range s.requestMetrics.pending {
		if sample.count != 1 || sample.errors != 0 {
			t.Fatal(sample)
		}
	}
	if len(s.requestMetrics.pending) != 1 {
		t.Fatal("missing stream sample")
	}
}
