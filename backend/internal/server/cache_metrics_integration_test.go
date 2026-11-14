package server

import (
	"context"
	"encoding/json"
	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func runCacheMetricsIntegration(t *testing.T, base *Server) {
	t.Run("persistent cache telemetry", func(t *testing.T) {
		ctx := context.Background()
		db := base.Store.DB.Client().Database("cache_metrics_" + bson.NewObjectID().Hex())
		defer db.Drop(ctx)
		s := &Server{Store: &Store{DB: db, Redis: base.Store.Redis}, cacheMetrics: testCacheMetrics(), Config: Config{Storage: "filesystem"}}
		other := &Server{Store: s.Store, cacheMetrics: testCacheMetrics()}
		other.cacheMetrics.instance = "second"
		if err := s.Store.ensureIndexes(ctx); err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		s.observeCacheAt(ctx, "source_hit", 20, time.Millisecond, now)
		other.observeCacheAt(ctx, "source_hit", 30, 2*time.Millisecond, now)
		s.observeCacheAt(ctx, "source_miss", 10, 0, now.Add(-2*time.Hour))
		var wg sync.WaitGroup
		for _, server := range []*Server{s, other} {
			wg.Add(1)
			go func(s *Server) {
				defer wg.Done()
				if err := s.flushCacheMetrics(ctx); err != nil {
					t.Error(err)
				}
			}(server)
		}
		wg.Wait()
		report := func(window string) M {
			result, err := s.adminCache(&request{W: httptest.NewRecorder(), R: httptest.NewRequest("GET", "/?minutes="+window, nil)})
			if err != nil {
				t.Fatal(err)
			}
			return obj(result)
		}
		out := report("60")
		rows := out["rows"].([]M)
		if !boolean(out["available"]) || len(rows) != 1 || number(rows[0]["count"]) != 2 || number(rows[0]["bytes"]) != 50 || number(rows[0]["b1"]) != 1 || number(rows[0]["b2"]) != 1 {
			t.Fatal(out)
		}

		// Live blob counters are independent of historical telemetry rows.
		source, err := blobcache.New(ctx, blobcache.Options{Root: t.TempDir(), Budget: 65536, MaxObject: 4096})
		if err != nil {
			t.Fatal(err)
		}
		defer source.Close()
		results, err := blobcache.New(ctx, blobcache.Options{Root: t.TempDir(), Budget: 32768, MaxObject: 2048})
		if err != nil {
			t.Fatal(err)
		}
		defer results.Close()
		s.Config.SharedCacheEnabled = true
		s.sourceCache = source
		s.resultCache = results
		reader, err := source.GetOrFill(ctx, "report-source", func(context.Context) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader("live source bytes")), nil
		}, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := results.SaveDecision(ctx, "decision", reader.Record().Digest, false); err != nil {
			reader.Close()
			t.Fatal(err)
		}
		liveReport := report("60")
		src, ok := liveReport["source"].(blobcache.Stats)
		if !ok {
			t.Fatal(liveReport)
		}
		res, ok := liveReport["results"].(blobcache.Stats)
		if !ok {
			t.Fatal(liveReport)
		}
		if !boolean(liveReport["enabled"]) || !boolean(liveReport["filesystemSupported"]) || src.Blobs != 1 || src.OriginalBytes != 17 || src.ActiveReaders != 1 || src.BudgetBytes != 65536 || res.Decisions != 1 || res.BudgetBytes != 32768 {
			t.Fatal(liveReport)
		}
		reader.Close()
		if stats := report("60")["source"].(blobcache.Stats); stats.ActiveReaders != 0 {
			t.Fatal("reader count not live", stats)
		}
		if got := report("10080"); len(got["rows"].([]M)) != 2 {
			t.Fatal("hourly history missing", got)
		}
		// A canceled flush drops its detached batch and reports loss after recovery.
		s.observeCache(ctx, "source_fill", 7, 0)
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		if err := s.flushCacheMetrics(canceled); err == nil {
			t.Fatal("canceled flush succeeded")
		}
		out = report("60")
		if number(out["dropped"]) != 1 || len(out["rows"].([]M)) != 1 {
			t.Fatal("lost or replayed batch", out)
		}
		// Exercise production startup/shutdown, including the worker's final flush.
		config := base.Config
		config.CacheMonitoring = true
		live, err := New(config, s.Store)
		if err != nil {
			t.Fatal(err)
		}
		live.observeCache(ctx, "source_fill_wait", 0, 0)
		live.Close()
		out = report("60")
		found := false
		for _, row := range out["rows"].([]M) {
			if row["name"] == "source_fill_wait" && number(row["count"]) == 1 {
				found = true
			}
		}
		if !found {
			t.Fatal("shutdown did not flush pending events", out)
		}
		docs, err := s.Store.list(ctx, "gocachemetrics", M{"period": 60000}, 0, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, doc := range docs {
			expected := time.UnixMilli(number(doc["bucket"])).Add(48 * time.Hour)
			if !date(doc["expires"]).Equal(expected) {
				t.Fatal("incorrect retention", doc)
			}
		}
		s.observeCache(ctx, "source_error", 0, 0)
		failedContext, stop := context.WithCancel(ctx)
		stop()
		telemetry, err := s.cacheTelemetry(&request{R: httptest.NewRequest("GET", "/?minutes=60", nil).WithContext(failedContext)})
		failedTelemetry := obj(telemetry)
		if err != nil || boolean(failedTelemetry["available"]) || failedTelemetry["reason"] != "Cache telemetry could not be read" || number(failedTelemetry["dropped"]) != 2 {
			t.Fatal("telemetry failure lost drop count", failedTelemetry, err)
		}
		results.Close()
		failed := report("60")
		if boolean(failed["available"]) || failed["reason"] != "The cache index is unavailable" || failed["source"] != nil || failed["results"] != nil {
			t.Fatal("failed cache leaked partial statistics", failed)
		}

	})
}

func runCacheReportHTTPIntegration(t *testing.T, base *Server) {
	t.Run("live cache report authorization", func(t *testing.T) {
		ctx := t.Context()
		config := base.Config
		config.Storage = "filesystem"
		config.SharedCacheEnabled = true
		config.SharedCacheDecisions = true
		config.SharedResultBytes = 32768
		config.CacheMonitoring = false
		config.SharedCache = blobcache.Options{Root: t.TempDir(), Budget: 65536, MaxObject: 4096}
		live, err := New(config, base.Store)
		if err != nil {
			t.Fatal(err)
		}
		defer live.Close()
		reader, err := live.sourceCache.GetOrFill(ctx, "http-report", func(context.Context) (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("cached")), nil }, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		reader.Close()
		tokens := []string{"cache-report-admin-" + bson.NewObjectID().Hex(), "cache-report-user-" + bson.NewObjectID().Hex()}
		for i, token := range tokens {
			id := bson.NewObjectID()
			if _, err := base.Store.DB.Collection("users").InsertOne(ctx, M{"_id": id, "username": "cache-report-fixture-" + id.Hex(), "status": "active", "isAdmin": i == 0, "apiTokens": []M{{"tokenHash": security.HashToken(token)}}}); err != nil {
				t.Fatal(err)
			}
			defer base.Store.DB.Collection("users").DeleteOne(context.Background(), M{"_id": id})
		}
		call := func(token string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("GET", "/api/admin/cache", nil)
			if token != "" {
				req.Header.Set("Authorization", "Bearer "+token)
			}
			out := httptest.NewRecorder()
			live.ServeHTTP(out, req)
			return out
		}
		for _, token := range []string{"", tokens[1]} {
			out := call(token)
			if out.Code != 401 || strings.Contains(out.Body.String(), "budgetBytes") {
				t.Fatal("cache stats leaked", out.Code, out.Body)
			}
		}
		out := call(tokens[0])
		if out.Code != 200 || out.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(out.Code, out.Header(), out.Body)
		}
		var report M
		if err := json.Unmarshal(out.Body.Bytes(), &report); err != nil {
			t.Fatal(err)
		}
		if report["reason"] != "Monitoring is disabled" || !boolean(report["enabled"]) || number(obj(report["source"])["blobs"]) != 1 || number(obj(report["results"])["budgetBytes"]) != 32768 {
			t.Fatal(report)
		}
		live.sourceCache.Close()
		out = call(tokens[0])
		if out.Code != 200 || !strings.Contains(out.Body.String(), "The cache index is unavailable") || strings.Contains(out.Body.String(), config.SharedCache.Root) {
			t.Fatal(out.Code, out.Body)
		}
	})
}
