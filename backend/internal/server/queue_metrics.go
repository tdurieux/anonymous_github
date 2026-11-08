package server

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type queueMetricPoint struct {
	TS        int64 `json:"ts"`
	Completed int64 `json:"completed"`
	Failed    int64 `json:"failed"`
	AvgMs     int64 `json:"avgMs"`
}
type queueMetricCacheKey struct {
	name    string
	minutes int64
}
type queueMetricCacheEntry struct {
	points  []queueMetricPoint
	expires time.Time
}
type queueMetricHistory struct {
	mu      sync.Mutex
	entries map[queueMetricCacheKey]queueMetricCacheEntry
}

func queueMetricSelection(raw string) (name, selected string, minutes int64, err error) {
	query := parseExtendedQuery(raw).object
	name, err = query["queue"].stringDefault("download")
	if err != nil {
		return
	}
	if queueAction(name) == "" {
		err = fail("queue_not_found", 404)
		return
	}
	selected, err = query["range"].stringDefault("1h")
	if err != nil {
		return
	}
	minutes = map[string]int64{"1h": 60, "6h": 360, "24h": 1440, "7d": 10080}[selected]
	if minutes == 0 {
		// TypeScript's range object inherits these nonnumeric properties;
		// its metric reader consequently produces an empty series.
		switch selected {
		case "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString":
		default:
			minutes = 60
		}
	}
	return
}
func (s *Server) queueMetric(ctx context.Context, job M, failed bool, duration time.Duration) {
	if s.Store == nil || s.Store.Redis == nil {
		return
	}
	name := "download"
	switch str(job["action"]) {
	case "remove", "expire":
		name = "remove"
	case "cache":
		name = "cache"
	}
	key := fmt.Sprintf("qmetrics:%s:%d", name, time.Now().Truncate(time.Minute).UnixMilli())
	field := "c"
	if failed {
		field = "f"
	}
	p := s.Store.Redis.TxPipeline()
	p.HIncrBy(ctx, key, field, 1)
	p.HIncrBy(ctx, key, "ms", int64(math.Round(math.Max(0, float64(duration)/float64(time.Millisecond)))))
	p.Expire(ctx, key, 7*24*time.Hour+time.Hour)
	p.Exec(ctx)
}
func (s *Server) queueMetrics(q *request) (any, error) {
	name, selected, minutes, err := queueMetricSelection(q.R.URL.RawQuery)
	if err != nil {
		return nil, err
	}
	return M{"queue": name, "range": selected, "points": s.queueMetricPoints(q.ctx(), name, minutes, time.Now())}, nil
}
func (s *Server) queueMetricPoints(ctx context.Context, name string, minutes int64, now time.Time) []queueMetricPoint {
	// Only three known queues and four normalized windows enter the cache.
	if queueAction(name) == "" || (minutes != 60 && minutes != 360 && minutes != 1440 && minutes != 10080) {
		return []queueMetricPoint{}
	}
	key := queueMetricCacheKey{name, minutes}
	s.queueHistory.mu.Lock()
	cached, ok := s.queueHistory.entries[key]
	s.queueHistory.mu.Unlock()
	if ok && now.Before(cached.expires) {
		return cached.points
	}
	if s.Store == nil || s.Store.Redis == nil {
		return []queueMetricPoint{}
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	minute := now.Truncate(time.Minute)
	points := make([]queueMetricPoint, 0, minutes)
	pipe := s.Store.Redis.Pipeline()
	commands := make([]*redis.SliceCmd, 0, minutes)
	for i := minutes - 1; i >= 0; i-- {
		at := minute.Add(-time.Duration(i) * time.Minute).UnixMilli()
		points = append(points, queueMetricPoint{TS: at})
		commands = append(commands, pipe.HMGet(ctx, fmt.Sprintf("qmetrics:%s:%d", name, at), "c", "f", "ms"))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return []queueMetricPoint{}
	}
	for i, command := range commands {
		values := command.Val()
		completed, failed, ms := errorPageInt(str(values[0]), 0), errorPageInt(str(values[1]), 0), errorPageInt(str(values[2]), 0)
		points[i].Completed, points[i].Failed = completed, failed
		if total := completed + failed; total > 0 {
			points[i].AvgMs = int64(math.Floor(float64(ms)/float64(total) + .5))
		}
	}
	s.queueHistory.mu.Lock()
	if s.queueHistory.entries == nil {
		s.queueHistory.entries = map[queueMetricCacheKey]queueMetricCacheEntry{}
	}
	s.queueHistory.entries[key] = queueMetricCacheEntry{points: points, expires: now.Add(30 * time.Second)}
	s.queueHistory.mu.Unlock()
	return points
}
