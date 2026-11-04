package server

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

var requestLatencyBuckets = []float64{10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000}

type requestMetricKey struct {
	minute                int64
	metric, route, method string
}
type requestSample struct {
	count, sumMs, bytes, aborted, errors, slow int64
	buckets                                    [12]int64
}
type requestMetrics struct {
	mu                          sync.Mutex
	flushMu                     sync.Mutex
	pending                     map[requestMetricKey]requestSample
	dropped                     atomic.Int64
	droppedBatches              atomic.Int64
	active                      atomic.Int64
	stop, done                  chan struct{}
	instance                    string
	sampledAt, cpuAt, lastFlush time.Time
	cpuSeconds                  float64
}

func (s *Server) startRequestMetrics() {
	if s.Store == nil || s.Store.Redis == nil {
		return
	}
	m := &requestMetrics{pending: map[requestMetricKey]requestSample{}, stop: make(chan struct{}), done: make(chan struct{})}
	host, _ := os.Hostname()
	m.instance = "api:" + host + ":" + strconv.Itoa(os.Getpid())
	if seconds, ok := processCPUSeconds(); ok {
		m.cpuAt, m.cpuSeconds = time.Now(), seconds
	}
	s.requestMetrics = m
	go func() {
		defer close(m.done)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-m.stop:
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				s.flushRequestMetrics(ctx)
				cancel()
			}
		}
	}()
}

func (m *requestMetrics) observe(key requestMetricKey, elapsed time.Duration, bytes int64, aborted, failed, slow bool) {
	ms := math.Max(0, float64(elapsed)/float64(time.Millisecond))
	m.mu.Lock()
	defer m.mu.Unlock()
	v, exists := m.pending[key]
	if !exists && len(m.pending) >= 512 {
		m.dropped.Add(1)
		return
	}
	v.count++
	v.sumMs += int64(math.Round(ms))
	v.bytes += bytes
	if aborted {
		v.aborted++
	}
	if failed {
		v.errors++
	}
	if slow {
		v.slow++
	}
	i := sort.SearchFloat64s(requestLatencyBuckets, ms)
	v.buckets[i]++
	m.pending[key] = v
}

// Labels are registered route templates or fixed fallbacks, never caller paths.
func (s *Server) performanceRoute(r *http.Request) string {
	for _, route := range s.routes {
		if route.pattern.MatchString(r.URL.Path) {
			return route.template
		}
	}
	path := r.URL.Path
	for _, prefix := range []string{"/script/", "/css/", "/fonts/", "/partials/", "/favicon/"} {
		if strings.HasPrefix(path, prefix) {
			return "/assets/:path"
		}
	}
	if path == "/healthcheck" || path == "/api/healthcheck" || path == "/github/app/webhook" {
		return path
	}
	return "other"
}

func (s *Server) monitorRequest(state *responseState, r *http.Request) func() {
	m := s.requestMetrics
	started := time.Now()
	route := s.performanceRoute(r)
	method := r.Method
	switch method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
	default:
		method = "OTHER"
	}
	if m != nil {
		m.active.Add(1)
	}
	return func() {
		if m != nil {
			m.active.Add(-1)
		}
		elapsed := time.Since(started)
		threshold := time.Second
		if strings.Contains(route, "/file/") || strings.HasSuffix(route, "/zip") || strings.HasPrefix(route, "/w/") {
			threshold = 10 * time.Second
		}
		bytes := state.bytes
		if method == "HEAD" {
			bytes = 0
		}
		aborted := r.Context().Err() != nil || state.writeFailed
		detail := traceFrom(r.Context()).log(r, state, route, method, started, elapsed, bytes, aborted, elapsed > threshold)
		if detail != nil {
			message := "slow request"
			if aborted {
				message = "request interrupted"
			}
			s.enqueueError("warn", "requests", message, "_", int(number(detail["status"])), detail)
		}
		if m == nil {
			return
		}
		key := requestMetricKey{time.Now().UnixMilli() / 60000 * 60000, "request", route, method}
		m.observe(key, elapsed, bytes, r.Context().Err() != nil || state.writeFailed, state.status >= 500, elapsed > threshold)
		if !state.firstWrite.IsZero() {
			key.metric = "first_byte"
			m.observe(key, state.firstWrite.Sub(started), 0, false, false, false)
		}
	}
}

func (s *Server) flushRequestMetrics(ctx context.Context) error {
	// Error persistence shares the existing bounded periodic flush lifecycle.
	if err := s.flushErrorLog(ctx); err != nil {
		return err
	}
	m := s.requestMetrics
	if m == nil {
		return nil
	}
	m.flushMu.Lock()
	defer m.flushMu.Unlock()
	m.mu.Lock()
	entries := m.pending
	m.pending = map[requestMetricKey]requestSample{}
	m.mu.Unlock()
	now := time.Now()
	sample := s.processSample(now)
	if len(entries) == 0 && sample == nil {
		return nil
	}
	pipe := s.Store.Redis.TxPipeline()
	if sample != nil {
		writeProcessSample(ctx, pipe, sample)
	}
	for k, v := range entries {
		key := "performance:v1:minute:api:" + strconv.FormatInt(k.minute, 10)
		label, _ := json.Marshal([]string{k.metric, k.route, k.method})
		for field, n := range map[string]int64{"count": v.count, "sumMs": v.sumMs, "bytes": v.bytes, "aborted": v.aborted, "errors": v.errors, "slow": v.slow} {
			pipe.HIncrBy(ctx, key, string(label)+"|"+field, n)
		}
		for i, n := range v.buckets {
			if n > 0 {
				pipe.HIncrBy(ctx, key, string(label)+"|b"+strconv.Itoa(i), n)
			}
		}
		pipe.Expire(ctx, key, 2*time.Hour)
	}
	_, err := pipe.Exec(ctx)
	// Do not replay an uncertain write: that would duplicate counts.
	if err != nil {
		m.droppedBatches.Add(1)
	} else {
		m.lastFlush = now
	}
	return err
}

func latencyUpper(buckets [12]int64, quantile float64) any {
	var total, cumulative int64
	for _, n := range buckets {
		total += n
	}
	if total == 0 {
		return nil
	}
	for i, n := range buckets {
		cumulative += n
		if float64(cumulative) >= math.Ceil(float64(total)*quantile) {
			if i == len(requestLatencyBuckets) {
				return nil
			}
			return requestLatencyBuckets[i]
		}
	}
	return nil
}

func (s *Server) requestPerformance(q *request) (any, error) {
	rawMinutes, err := extendedQueryString(q.R.URL.RawQuery, "minutes")
	if err != nil {
		return nil, err
	}
	minutes := int64(15)
	if queryWindowNumber(rawMinutes) == 60 {
		minutes = 60
	}
	out := M{"available": false, "windowMinutes": minutes, "instances": []any{}, "routes": []M{}, "stages": []M{}, "series": []M{}, "runtimeSeries": []any{}, "latencyBucketsMs": requestLatencyBuckets, "percentileNote": "Percentiles are histogram bucket upper bounds; null means no samples or above 60s."}
	if s.requestMetrics == nil {
		return out, nil
	}
	ctx, cancel := context.WithTimeout(q.ctx(), 3*time.Second)
	defer cancel()
	if s.flushRequestMetrics(ctx) != nil {
		return out, nil
	}
	now := time.Now()
	minute := now.UnixMilli() / 60000 * 60000
	type read struct {
		service string
		minute  int64
		cmd     *redis.MapStringStringCmd
	}
	reads := []read{}
	pipe := s.Store.Redis.Pipeline()
	for _, service := range []string{"api", "streamer"} {
		for i := int64(0); i < minutes; i++ {
			at := minute - i*60000
			reads = append(reads, read{service, at, pipe.HGetAll(ctx, "performance:v1:minute:"+service+":"+strconv.FormatInt(at, 10))})
		}
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return out, nil
	}
	type group struct{ service, metric, route, method string }
	groups := map[group]requestSample{}
	series := map[int64]M{}
	for _, read := range reads {
		for label, raw := range read.cmd.Val() {
			split := strings.LastIndexByte(label, '|')
			if split < 0 {
				continue
			}
			var fields []string
			if json.Unmarshal([]byte(label[:split]), &fields) != nil || len(fields) != 3 {
				continue
			}
			n, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || n < 0 {
				continue
			}
			g := group{read.service, fields[0], fields[1], fields[2]}
			v := groups[g]
			field := label[split+1:]
			switch field {
			case "count":
				v.count += n
			case "sumMs":
				v.sumMs += n
			case "bytes":
				v.bytes += n
			case "aborted":
				v.aborted += n
			case "errors":
				v.errors += n
			case "slow":
				v.slow += n
			default:
				if strings.HasPrefix(field, "b") {
					i, e := strconv.Atoi(field[1:])
					if e == nil && i >= 0 && i < len(v.buckets) {
						v.buckets[i] += n
					}
				}
			}
			groups[g] = v
			if g.service == "api" && g.metric == "request" {
				point := series[read.minute]
				if point == nil {
					point = M{"minute": read.minute, "requests": int64(0), "aborted": int64(0), "errors": int64(0), "sumMs": int64(0)}
				}
				target := field
				if field == "count" {
					target = "requests"
				}
				if _, ok := point[target]; ok && target != "minute" {
					point[target] = number(point[target]) + n
				}
				series[read.minute] = point
			}
		}
	}
	routes, stages := []M{}, []M{}
	for g, v := range groups {
		avg := float64(0)
		if v.count > 0 {
			avg = math.Round(float64(v.sumMs) / float64(v.count))
		}
		row := M{"service": g.service, "metric": g.metric, "route": g.route, "method": g.method, "count": v.count, "sumMs": v.sumMs, "bytes": v.bytes, "aborted": v.aborted, "errors": v.errors, "slow": v.slow, "buckets": v.buckets, "avgMs": avg, "p95UpperMs": latencyUpper(v.buckets, .95), "p99UpperMs": latencyUpper(v.buckets, .99)}
		if g.metric == "request" {
			first := groups[group{g.service, "first_byte", g.route, g.method}]
			row["firstByteCount"] = first.count
			row["firstByteP95UpperMs"] = latencyUpper(first.buckets, .95)
			routes = append(routes, row)
		} else {
			stages = append(stages, row)
		}
	}
	sort.Slice(routes, func(i, j int) bool { return number(routes[i]["sumMs"]) > number(routes[j]["sumMs"]) })
	points := []M{}
	for _, p := range series {
		points = append(points, p)
	}
	sort.Slice(points, func(i, j int) bool { return number(points[i]["minute"]) < number(points[j]["minute"]) })
	instances, runtimeSeries, err := s.readProcessSamples(ctx, now, minutes)
	if err != nil {
		return out, nil
	}
	out["instances"], out["runtimeSeries"] = instances, runtimeSeries
	out["available"], out["generatedAt"], out["routes"], out["stages"], out["series"] = true, now.UnixMilli(), routes, stages, points
	out["droppedMetrics"], out["droppedBatches"] = s.requestMetrics.dropped.Load(), s.requestMetrics.droppedBatches.Load()
	return out, nil
}
