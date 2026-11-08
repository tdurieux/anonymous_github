package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRequestTraceIDsWithoutRedis(t *testing.T) {
	s := &Server{}
	seen := map[string]bool{}
	for _, path := range []string{"/api/healthcheck", "/api/repo/private/file/secret%2fpath?token=private-token"} {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("X-Request-ID", "attacker-controlled-id")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		id := w.Header().Get("X-Request-ID")
		parsed, err := uuid.Parse(id)
		if err != nil || parsed.Version() != 4 || seen[id] {
			t.Fatal("missing, invalid or reused generated request ID", id)
		}
		seen[id] = true
	}
}

func TestRequestTraceLoggingPrivacyAndStages(t *testing.T) {
	var output bytes.Buffer
	trace := newRequestTrace()
	trace.logger = slog.New(slog.NewJSONHandler(&output, nil))
	ctx := context.WithValue(context.Background(), performanceContextKey{}, trace)
	s := &Server{}
	s.add("GET", "/api/repo/:id/file/*path", "", nil)
	// Concurrent work is accumulated into the same request without leaking IDs
	// or depending on Redis being available.
	var workers sync.WaitGroup
	for i := 0; i < 32; i++ {
		workers.Add(1)
		go func() { defer workers.Done(); s.stageObserver(ctx)("anonymize", time.Millisecond, nil) }()
	}
	workers.Wait()
	s.stageObserver(ctx)("private-stage-name", time.Second, nil)
	r := httptest.NewRequest("GET", "/api/repo/private-repo/file/private-file?token=private-token", nil).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer private-credential")
	state := &responseState{ResponseWriter: httptest.NewRecorder()}
	done := s.monitorRequest(state, r)
	state.WriteHeader(200)
	io.WriteString(state, "body")
	done()
	var row map[string]any
	if err := json.Unmarshal(output.Bytes(), &row); err != nil {
		t.Fatal(err, output.String())
	}
	if row["requestId"] != trace.id || row["route"] != "/api/repo/:id/file/*path" || row["bytes"] != float64(4) || row["status"] != float64(200) || row["level"] != "INFO" || row["outcome"] != "completed" {
		t.Fatal(row)
	}
	stages := row["stages"].(map[string]any)
	if stages["anonymize"] != float64(32) || len(stages) != 1 {
		t.Fatal(stages)
	}
	if strings.Contains(output.String(), "private-") {
		t.Fatal("private request data leaked into logs")
	}
}

func TestRequestTraceInterruptedAndHealthLogging(t *testing.T) {
	for _, interrupted := range []bool{false, true} {
		var output bytes.Buffer
		trace := newRequestTrace()
		trace.logger = slog.New(slog.NewJSONHandler(&output, nil))
		ctx, cancel := context.WithCancel(context.WithValue(context.Background(), performanceContextKey{}, trace))
		s := &Server{}
		r := httptest.NewRequest("GET", "/api/healthcheck", nil).WithContext(ctx)
		state := &responseState{ResponseWriter: httptest.NewRecorder()}
		done := s.monitorRequest(state, r)
		if interrupted {
			cancel()
		}
		done()
		cancel()
		if !interrupted {
			if output.Len() != 0 {
				t.Fatal("successful healthcheck logged")
			}
			continue
		}
		var row map[string]any
		if err := json.Unmarshal(output.Bytes(), &row); err != nil {
			t.Fatal(err)
		}
		if row["level"] != "WARN" || row["outcome"] != "interrupted" || row["firstByteMs"] != nil {
			t.Fatal(row)
		}
	}
}

func TestRequestTraceLegacyCacheResults(t *testing.T) {
	s := &Server{requestMetrics: &requestMetrics{pending: map[requestMetricKey]requestSample{}}}
	ctx := context.WithValue(context.Background(), performanceContextKey{}, newRequestTrace())
	for _, name := range []string{"legacy_source_hit", "legacy_source_miss", "legacy_result_hit", "legacy_result_miss", "source_hit", "result_hit", "arbitrary"} {
		s.observeCache(ctx, name, 123, time.Second)
		s.observeCache(context.Background(), name, 123, time.Second)
	}
	if len(s.requestMetrics.pending) != 4 {
		t.Fatal(s.requestMetrics.pending)
	}
	expected := map[string]bool{"source_hit": true, "source_miss": true, "transformed_hit": true, "transformed_miss": true}
	for key, v := range s.requestMetrics.pending {
		if !expected[key.metric] || key.route != "all" || key.method != "all" || v.count != 1 || v.bytes != 0 || v.sumMs != 0 {
			t.Fatal(key, v)
		}
	}
}
