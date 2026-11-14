package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"math"
	"strings"
	"sync"
	"testing"
)

type forbiddenValue struct{}

func (forbiddenValue) LogValue() slog.Value { panic("must not resolve user values") }
func (forbiddenValue) String() string       { panic("must not format user values") }

func TestPrivateDataNeverSerialized(t *testing.T) {
	var b bytes.Buffer
	logger := slog.New(New(&b, slog.LevelDebug, "secret-release"))
	logger.With("token", "secret-token", "requestId", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").Error("https://private.example/secret-repo",
		"error", "secret-error", "url", "https://private.example/secret", "body", forbiddenValue{}, "ms", forbiddenValue{},
		"route", "/api/repo/secret-name", "code", "quota_exceeded", "status", 402, "severity", "debug", "instance", "secret-instance",
		"stages", map[string]float64{"upstream": 2.5, "secret-stage": 9, "repository": math.Inf(1)})
	if strings.Contains(b.String(), "secret") || strings.Contains(b.String(), "private.example") {
		t.Fatal(b.String())
	}
	var record map[string]any
	if err := json.Unmarshal(b.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if record["event"] != "application_log" || record["severity"] != "error" || record["errorCode"] != "quota_exceeded" || record["status"] != float64(402) || record["stage_upstream_ms"] != 2.5 || record["requestId"] == nil {
		t.Fatal(record)
	}
	for _, key := range []string{"route", "ms", "stage_repository_ms", "body", "url", "token"} {
		if record[key] != nil {
			t.Fatal(key, record)
		}
	}
}

func TestCollectorFieldsAndGroups(t *testing.T) {
	var b bytes.Buffer
	logger := slog.New(New(&b, slog.LevelInfo, "abcdef123"))
	logger.Debug("request", "status", 200)
	logger.With("service", "worker", "queue", "download").Info("job started", "attempt", 2, "jobId", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
	logger.With("method", "GET").WithGroup("private").With("status", 999).Info("request", "route", "/api/repo/:id/file/:path", "status", 400)
	rows := strings.Split(strings.TrimSpace(b.String()), "\n")
	if len(rows) != 2 {
		t.Fatal(b.String())
	}
	for i, line := range rows {
		var r map[string]any
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatal(err)
		}
		if r["release"] != "abcdef123" || !traceID.MatchString(r["instance"].(string)) || r["timestamp"] == nil {
			t.Fatal(r)
		}
		if i == 0 && (r["event"] != "job_started" || r["service"] != "worker" || r["attempt"] != float64(2) || r["queue"] != "download") {
			t.Fatal(r)
		}
		if i == 1 && (r["method"] != "GET" || r["status"] != nil || r["route"] != nil) {
			t.Fatal(r)
		}
	}
}

func TestConcurrentRecordsRemainJSON(t *testing.T) {
	var b bytes.Buffer
	logger := slog.New(New(&b, slog.LevelInfo, ""))
	var workers sync.WaitGroup
	for i := 0; i < 20; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			logger.With("method", "GET").Info("request", "route", "/healthcheck", "status", 200)
		}()
	}
	workers.Wait()
	rows := strings.Split(strings.TrimSpace(b.String()), "\n")
	if len(rows) != 20 {
		t.Fatal(len(rows))
	}
	for _, row := range rows {
		var record map[string]any
		if err := json.Unmarshal([]byte(row), &record); err != nil {
			t.Fatal(err)
		}
		if record["event"] != "request_completed" || record["route"] != "/healthcheck" {
			t.Fatal(record)
		}
	}
}

func TestZIPFailureKeepsFixedDiagnostics(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(New(&output, slog.LevelInfo, ""))
	logger.Warn("ZIP transfer stopped", "stage", "authorization", "reason", "client_cancelled")
	var row map[string]any
	if err := json.Unmarshal(output.Bytes(), &row); err != nil {
		t.Fatal(err)
	}
	if row["stage"] != "authorization" || row["reason"] != "client_cancelled" || row["event"] != "zip_stream_failed" {
		t.Fatal(row)
	}
}
