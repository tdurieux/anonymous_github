package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestErrorLogTypeScriptContracts(t *testing.T) {
	data, err := os.ReadFile("testdata/error-log.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Max            int
		Classification []struct {
			Level  string
			Status int
			Bucket string
		}
		Pagination []struct {
			Input         string
			Offset, Limit int64
		}
		Noisy []string
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Max != errorLogMax {
		t.Fatal(fixture.Max, errorLogMax)
	}
	for _, row := range fixture.Classification {
		if got := errorBucket(row.Status, row.Level); got != row.Bucket {
			t.Fatal(row, got)
		}
	}
	for _, row := range fixture.Pagination {
		offset := max(0, errorPageInt(row.Input, 0))
		limit := min(int64(errorLogMax), max(int64(1), errorPageInt(row.Input, 250)))
		if offset != row.Offset || limit != row.Limit {
			t.Fatal(row, offset, limit)
		}
	}
	for _, code := range fixture.Noisy {
		if !noisyError(code) {
			t.Fatal(code)
		}
	}
	if noisyError("rate_limited") {
		t.Fatal("unexpected noisy code")
	}
}
func TestErrorLogBoundedAndPrivate(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	defer client.Close()
	s := &Server{Store: &Store{Redis: client}}
	for i := 0; i < errorLogBuffer+10; i++ {
		s.recordError(context.Background(), fail("upstream_failure", 502))
	}
	if len(s.errorLog.pending) != errorLogBuffer || s.errorLog.dropped.Load() != 10 {
		t.Fatal("unbounded error buffer")
	}
	s.errorLog.pending = nil
	s.recordError(context.Background(), fail("secret https://user:password@example.org/private", 500))
	if strings.Contains(string(s.errorLog.pending[0].data), "password") || s.errorLog.pending[0].code != "server_error" {
		t.Fatal("unsafe error text")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if s.flushErrorLog(ctx) == nil || len(s.errorLog.pending) != 0 || s.errorLog.dropped.Load() != 11 {
		t.Fatal("uncertain batch replayed or not counted")
	}
}
func runErrorLogIntegration(t *testing.T, base *Server) {
	options := *base.Store.Redis.Options()
	options.DB = 15
	client := redis.NewClient(&options)
	defer client.Close()
	ctx := context.Background()
	if err := client.FlushDB(ctx).Err(); err != nil {
		t.Fatal(err)
	}
	defer client.FlushDB(ctx)
	s := &Server{Store: &Store{Redis: client}}
	for _, row := range []struct {
		code   string
		status int
	}{{"server_error", 500}, {"not_found", 404}, {"repository_expired", 410}, {"rate_limited", 429}} {
		s.recordError(ctx, fail(row.code, row.status))
	}
	trace := newRequestTrace()
	trace.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	requestCtx, cancel := context.WithCancel(context.WithValue(ctx, performanceContextKey{}, trace))
	r := httptest.NewRequest("GET", "/api/healthcheck", nil).WithContext(requestCtx)
	done := s.monitorRequest(&responseState{ResponseWriter: httptest.NewRecorder()}, r)
	cancel()
	done()
	query := func(method, path string) *request {
		return &request{Server: s, R: httptest.NewRequest(method, path, nil)}
	}
	report, err := s.adminErrors(query("GET", "/api/admin/errors?limit=5001"))
	if err != nil {
		t.Fatal(err)
	}
	row := obj(report)
	if number(row["total"]) != 3 || number(row["max"]) != 5000 || number(row["limit"]) != 5000 {
		t.Fatal(row)
	}
	entries := arr(row["entries"])
	if obj(entries[0])["message"] != "request interrupted" {
		t.Fatal(entries)
	}
	stats, err := s.errorStats(query("GET", "/api/admin/errors/stats"))
	if err != nil {
		t.Fatal(err)
	}
	summary := obj(stats)
	severity := obj(summary["severity"])
	if number(summary["last24h"]) != 5 || number(severity["error"]) != 1 || number(severity["warn"]) != 3 || number(severity["info"]) != 1 {
		t.Fatal(summary)
	}
	hourly := "admin:errors:hourly:" + time.Now().UTC().Format("2006010215")
	counters, err := client.HGetAll(ctx, hourly).Result()
	if err != nil {
		t.Fatal(err)
	}
	if counters["level:warn"] != "4" || counters["module:requests"] != "1" || counters["cb:info:not_found"] != "1" {
		t.Fatal(counters)
	}
	if ttl := client.TTL(ctx, hourly).Val(); ttl < 47*time.Hour || ttl > 48*time.Hour {
		t.Fatal(ttl)
	}
	// Malformed legacy entries retain the TypeScript fallback shape.
	client.LPush(ctx, "admin:errors", "malformed legacy entry")
	report, err = s.adminErrors(query("GET", "/api/admin/errors?limit=1"))
	if err != nil {
		t.Fatal(err)
	}
	malformed := obj(arr(obj(report)["entries"])[0])
	if malformed["ts"] != nil || malformed["module"] != nil || len(arr(malformed["raw"])) != 0 {
		t.Fatal(malformed)
	}
	// Ring trimming is independent from hourly history.
	values := make([]any, errorLogMax)
	for i := range values {
		values[i] = `{"message":"fixture"}`
	}
	client.RPush(ctx, "admin:errors", values...)
	s.recordError(ctx, fail("latest_failure", 500))
	if err = s.flushErrorLog(ctx); err != nil {
		t.Fatal(err)
	}
	if n := client.LLen(ctx, "admin:errors").Val(); n != errorLogMax {
		t.Fatal(n)
	}
	client.Set(ctx, "admin:errors:dropped", 7, 0)
	client.HSet(ctx, "admin:errors:hourly:old", "total", 1)
	client.Set(ctx, "unrelated-test-key", "preserved", 0)
	report, err = s.adminErrors(query("DELETE", "/api/admin/errors"))
	if err != nil {
		t.Fatal(err)
	}
	if number(obj(report)["cleared"]) != errorLogMax || number(obj(report)["hourlyCleared"]) < 2 {
		t.Fatal(report)
	}
	if n := client.Exists(ctx, "admin:errors", hourly, "admin:errors:hourly:old", "admin:errors:dropped").Val(); n != 0 {
		t.Fatal("clear left history", n)
	}
	if client.Get(ctx, "unrelated-test-key").Val() != "preserved" {
		t.Fatal("clear deleted unrelated data")
	}
}
