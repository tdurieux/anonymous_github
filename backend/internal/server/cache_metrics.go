package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var cacheLatencyBuckets = []float64{0.1, 1, 10, 100, 1000, 10000}

type cacheTrafficKey struct{}

func cacheTraffic(r *http.Request) string {
	agent := strings.ToLower(r.UserAgent())
	if strings.Contains(agent, "uptime") || strings.Contains(agent, "healthcheck") || strings.Contains(agent, "monitor") {
		return "monitor"
	}
	for _, part := range strings.Split(r.URL.Path, "/") {
		if part == "zip" || part == "download" {
			return "zip"
		}
	}
	if strings.HasPrefix(r.URL.Path, "/w/") {
		return "website"
	}
	return "file"
}

type cacheMetricKey struct {
	minute        int64
	name, traffic string
}
type cacheSample struct {
	count, bytes int64
	ms           float64
	buckets      [7]int64
}
type cacheMetrics struct {
	mu        sync.Mutex
	flushMu   sync.Mutex
	pending   map[cacheMetricKey]cacheSample
	dropped   atomic.Int64
	lastFlush atomic.Int64
	instance  string
	stop      chan struct{}
	done      chan struct{}
}

func (s *Server) startCacheMetrics() {
	if !s.Config.CacheMonitoring {
		return
	}
	s.cacheMetrics = &cacheMetrics{pending: map[cacheMetricKey]cacheSample{}, instance: bson.NewObjectID().Hex(), stop: make(chan struct{}), done: make(chan struct{})}
	go func() {
		defer close(s.cacheMetrics.done)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				s.flushCacheMetrics(ctx)
				cancel()
			case <-s.cacheMetrics.stop:
				return
			}
		}
	}()
}
func (s *Server) observeCache(ctx context.Context, name string, bytes int64, elapsed time.Duration) {
	s.observeCacheAt(ctx, name, bytes, elapsed, time.Now())
}
func (s *Server) observeCacheAt(ctx context.Context, name string, bytes int64, elapsed time.Duration, now time.Time) {
	// Match TypeScript's legacy cache-result counters independently of optional
	// detailed cache monitoring. Shared-cache results have their own report.
	if s.requestMetrics != nil && traceFrom(ctx) != nil {
		metric := ""
		switch name {
		case "legacy_source_hit":
			metric = "source_hit"
		case "legacy_source_miss":
			metric = "source_miss"
		case "legacy_result_hit":
			metric = "transformed_hit"
		case "legacy_result_miss":
			metric = "transformed_miss"
		}
		if metric != "" {
			s.requestMetrics.observe(requestMetricKey{now.Truncate(time.Minute).UnixMilli(), metric, "all", "all"}, 0, 0, false, false, false)
		}
	}

	m := s.cacheMetrics
	if m == nil {
		return
	}
	// Only fixed event labels may enter persistent telemetry.
	switch name {
	case "legacy_source_hit", "legacy_source_miss", "decision_hit", "decision_miss", "decision_bypass", "rewrite_changed", "rewrite_unchanged", "rewrite_binary", "rewrite_changed_cached", "rewrite_unchanged_cached", "result_hit", "result_miss", "result_fill", "result_stored", "result_fill_wait", "result_bypass", "result_error", "result_deduplicated", "result_corrupt", "result_refetch", "result_known_miss", "result_first_seen_miss", "result_reuse_1h", "result_reuse_1d", "result_reuse_7d", "result_eviction", "source_legacy_promotion", "source_deduplicated", "source_corrupt", "source_refetch", "source_known_miss", "source_first_seen_miss", "source_reuse_1h", "source_reuse_1d", "source_reuse_7d", "source_eviction", "compress", "decompress", "legacy_result_hit", "legacy_result_miss", "source_hit", "source_miss", "source_fill", "source_stored", "source_fill_wait", "source_bypass", "source_error":
	default:
		return
	}
	traffic, _ := ctx.Value(cacheTrafficKey{}).(string)
	switch traffic {
	case "file", "website", "zip", "monitor":
	default:
		traffic = "background"
	}
	key := cacheMetricKey{now.Truncate(time.Minute).UnixMilli(), name, traffic}
	m.mu.Lock()
	defer m.mu.Unlock()
	v, exists := m.pending[key]
	if !exists && len(m.pending) >= 512 {
		m.dropped.Add(1)
		return
	}
	v.count++
	v.bytes += max(0, bytes)
	ms := max(0, float64(elapsed)/float64(time.Millisecond))
	v.ms += ms
	bucket := len(cacheLatencyBuckets)
	for i, bound := range cacheLatencyBuckets {
		if ms <= bound {
			bucket = i
			break
		}
	}
	v.buckets[bucket]++
	m.pending[key] = v
}
func (s *Server) flushCacheMetrics(ctx context.Context) error {
	m := s.cacheMetrics
	if m == nil {
		return nil
	}
	if !m.flushMu.TryLock() {
		return errors.New("cache_metrics_flush_busy")
	}
	defer m.flushMu.Unlock()
	m.mu.Lock()
	pending := m.pending
	m.pending = map[cacheMetricKey]cacheSample{}
	m.mu.Unlock()
	models := []mongo.WriteModel{}
	var count int64
	for key, v := range pending {
		count += v.count
		for _, period := range []int64{60000, 3600000} {
			bucket := key.minute / period * period
			retention := 48 * time.Hour
			if period == 3600000 {
				retention = 30 * 24 * time.Hour
			}
			inc := M{"count": v.count, "bytes": v.bytes, "ms": v.ms}
			for i, n := range v.buckets {
				inc[fmt.Sprintf("b%d", i)] = n
			}
			id := fmt.Sprintf("%d:%d:%s:%s", period, bucket, key.name, key.traffic)
			models = append(models, mongo.NewUpdateOneModel().SetFilter(M{"_id": id}).SetUpsert(true).SetUpdate(M{"$inc": inc, "$setOnInsert": M{"period": period, "bucket": bucket, "name": key.name, "traffic": key.traffic, "expires": time.UnixMilli(bucket).Add(retention)}}))
		}
	}
	coll := s.Store.DB.Collection("gocachemetrics")
	if len(models) > 0 {
		if _, err := coll.BulkWrite(ctx, models, options.BulkWrite().SetOrdered(false)); err != nil {
			// A partially successful flush is not replayed, avoiding double counting.
			// Dropped is a conservative upper bound when the write result is uncertain.
			m.dropped.Add(count)
			return err
		}
	}
	now := time.Now()
	_, err := coll.UpdateOne(ctx, M{"_id": "health:" + m.instance}, M{"$set": M{"period": 0, "dropped": m.dropped.Load(), "expires": now.Add(30 * 24 * time.Hour)}}, options.UpdateOne().SetUpsert(true))
	if err == nil {
		m.lastFlush.Store(now.UnixMilli())
	}
	return err
}
func (s *Server) adminCache(q *request) (any, error) {
	q.W.Header().Set("Cache-Control", "no-store")
	report, err := s.cacheTelemetry(q)
	if err != nil {
		return nil, err
	}
	out := obj(report)
	out["enabled"] = s.Config.SharedCacheEnabled
	out["filesystemSupported"] = s.Config.Storage == "filesystem"
	out["source"], out["results"] = nil, nil
	ctx, cancel := context.WithTimeout(q.ctx(), 5*time.Second)
	defer cancel()
	for name, cache := range map[string]*blobcache.Cache{"source": s.sourceCache, "results": s.resultCache} {
		if cache == nil {
			continue
		}
		stats, err := cache.Stats(ctx)
		if err != nil {
			return M{"available": false, "reason": "The cache index is unavailable", "rows": []M{}}, nil
		}
		out[name] = stats
	}
	return out, nil
}

func (s *Server) cacheTelemetry(q *request) (any, error) {
	rawMinutes, err := extendedQueryString(q.R.URL.RawQuery, "minutes")
	if err != nil {
		return nil, err
	}
	unavailable := func(reason string) (any, error) {
		out := M{"available": false, "reason": reason, "rows": []M{}}
		if s.cacheMetrics != nil {
			out["dropped"] = s.cacheMetrics.dropped.Load()
		}
		return out, nil
	}
	if s.cacheMetrics == nil {
		return unavailable("Monitoring is disabled")
	}
	ctx, cancel := context.WithTimeout(q.ctx(), 5*time.Second)
	defer cancel()
	if err := s.flushCacheMetrics(ctx); err != nil {
		return unavailable("Cache telemetry could not be read")
	}
	minutes := cacheWindow([]string{rawMinutes})
	period := int64(60000)
	if minutes > 2880 {
		period = 3600000
	}
	now := time.Now()
	group := M{"_id": M{"name": "$name", "traffic": "$traffic"}}
	project := M{"_id": 0, "name": "$_id.name", "traffic": "$_id.traffic"}
	for _, field := range []string{"count", "bytes", "ms", "b0", "b1", "b2", "b3", "b4", "b5", "b6"} {
		group[field] = M{"$sum": "$" + field}
		project[field] = 1
	}
	query := []M{{"$match": M{"period": period, "bucket": M{"$gte": now.Add(-time.Duration(minutes) * time.Minute).UnixMilli()}}}, {"$group": group}, {"$project": project}, {"$sort": bson.D{{Key: "name", Value: 1}, {Key: "traffic", Value: 1}}}}
	cursor, err := s.Store.DB.Collection("gocachemetrics").Aggregate(ctx, query)
	if err != nil {
		return unavailable("Cache telemetry could not be read")
	}
	defer cursor.Close(ctx)
	rows := []M{}
	if err = cursor.All(ctx, &rows); err != nil {
		return unavailable("Cache telemetry could not be read")
	}
	health, err := s.Store.DB.Collection("gocachemetrics").Aggregate(ctx, []M{{"$match": M{"period": 0, "expires": M{"$gt": now}}}, {"$group": M{"_id": nil, "dropped": M{"$sum": "$dropped"}}}})
	if err != nil {
		return unavailable("Cache telemetry could not be read")
	}
	defer health.Close(ctx)
	totals := []M{}
	if err = health.All(ctx, &totals); err != nil {
		return unavailable("Cache telemetry could not be read")
	}
	var dropped int64
	if len(totals) > 0 {
		dropped = number(totals[0]["dropped"])
	}
	return M{"available": true, "windowMinutes": minutes, "sampledAt": now.UnixMilli(), "lastFlush": s.cacheMetrics.lastFlush.Load(), "dropped": dropped, "rows": rows, "latencyBucketsMs": cacheLatencyBuckets}, nil
}

func cacheWindow(values []string) int {
	n := queryWindowNumber(strings.Join(values, ","))
	switch n {
	case 15, 60, 1440, 10080:
		return int(n)
	}
	return 60
}
