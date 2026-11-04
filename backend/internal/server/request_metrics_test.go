package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestRequestMetricBoundsAndPercentiles(t *testing.T) {
	m := &requestMetrics{pending: map[requestMetricKey]requestSample{}}
	key := requestMetricKey{0, "request", "/api/repo/:id/file/*path", "GET"}
	for _, ms := range []int{0, 10, 11, 50, 60001} {
		m.observe(key, time.Duration(ms)*time.Millisecond, 3, false, false, false)
	}
	v := m.pending[key]
	if v.count != 5 || v.bytes != 15 || v.buckets[0] != 2 || v.buckets[1] != 2 || v.buckets[11] != 1 || latencyUpper(v.buckets, .95) != nil || latencyUpper(v.buckets, .5) != float64(50) {
		t.Fatalf("unexpected histogram: %+v", v)
	}
	for i := 0; i < 600; i++ {
		k := key
		k.minute = int64(i + 1)
		m.observe(k, time.Millisecond, 0, false, false, false)
	}
	if len(m.pending) != 512 || m.dropped.Load() != 89 {
		t.Fatal("unbounded pending metrics")
	}
}

func TestRequestMetricHTTPPrivacyAndCompression(t *testing.T) {
	m := &requestMetrics{pending: map[requestMetricKey]requestSample{}}
	s := &Server{requestMetrics: m}
	s.add("GET", "/api/repo/:id/file/*path", "", nil)
	secretPath := "/api/repo/private-repository/file/private-file.txt"
	req := httptest.NewRequest("GET", secretPath+"?token=private-query", nil)
	if label := s.performanceRoute(req); label != "/api/repo/:id/file/*path" {
		t.Fatal("unsafe route label", label)
	}
	// The real handler path validates compression accounting and first-byte timing.
	for _, method := range []string{"GET", "HEAD"} {
		r := httptest.NewRequest(method, "/api/healthcheck", nil)
		r.Header.Set("Accept-Encoding", "gzip")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code)
		}
		for k, v := range m.pending {
			if k.method == method && k.metric == "request" {
				if v.count != 1 || v.errors != 0 || v.aborted != 0 || v.bytes != int64(w.Body.Len()) {
					t.Fatalf("wire count: %+v, actual %d", v, w.Body.Len())
				}
				first := k
				first.metric = "first_byte"
				if m.pending[first].count != 1 {
					t.Fatal("missing first-byte sample")
				}
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest("GET", "/api/healthcheck", nil).WithContext(ctx)
	func() {
		defer func() {
			if value := recover(); value != nil && value != http.ErrAbortHandler {
				panic(value)
			}
		}()
		s.ServeHTTP(httptest.NewRecorder(), r)
	}()
	var aborted int64
	for k, v := range m.pending {
		if k.metric == "request" {
			aborted += v.aborted
		}
	}
	if aborted != 1 || m.active.Load() != 0 {
		t.Fatal("cancellation/active accounting")
	}
	for k := range m.pending {
		if strings.Contains(k.route, "private") {
			t.Fatal("sensitive label stored")
		}
	}
}

func runRequestMetricsIntegration(t *testing.T, base *Server) {
	m := &requestMetrics{pending: map[requestMetricKey]requestSample{}}
	s := &Server{Store: base.Store, requestMetrics: m}
	now := time.Now().UnixMilli() / 60000 * 60000
	label := "/metric-test-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	k := requestMetricKey{now, "request", label, "GET"}
	m.observe(k, 25*time.Millisecond, 9, false, false, false)
	m.observe(k, 75*time.Millisecond, 11, true, true, false)
	first := k
	first.metric = "first_byte"
	m.observe(first, 5*time.Millisecond, 0, false, false, false)
	old := k
	old.minute = now - 16*60000
	m.observe(old, time.Second, 0, false, false, false)
	report, err := s.requestPerformance(&request{Server: s, R: httptest.NewRequest("GET", "/api/admin/performance", nil)})
	if err != nil || !boolean(obj(report)["available"]) {
		t.Fatal("report unavailable", err)
	}
	check := func(report any, want int64) {
		t.Helper()
		for _, row := range arr(obj(report)["routes"]) {
			r := obj(row)
			if r["route"] == label {
				if number(r["count"]) != want || number(r["bytes"]) != 20 || number(r["firstByteCount"]) != 1 || number(r["aborted"]) != 1 || number(r["errors"]) != 1 {
					t.Fatalf("incorrect aggregation: %v", r)
				}
				if want == 2 && (number(r["avgMs"]) != 50 || number(r["p95UpperMs"]) != 100 || number(r["firstByteP95UpperMs"]) != 10) {
					t.Fatal("incorrect bounds", r)
				}
				return
			}
		}
		t.Fatal("request group absent")
	}
	check(report, 2)
	// A second process reads shared persisted history and the 60-minute window.
	other := &Server{Store: base.Store, requestMetrics: &requestMetrics{pending: map[requestMetricKey]requestSample{}}}
	report, err = other.requestPerformance(&request{Server: other, R: httptest.NewRequest("GET", "/api/admin/performance?minutes=60", nil)})
	if err != nil {
		t.Fatal(err)
	}
	check(report, 3)
	ttl, err := base.Store.Redis.TTL(context.Background(), "performance:v1:minute:api:"+strconv.FormatInt(now, 10)).Result()
	if err != nil || ttl <= time.Hour || ttl > 2*time.Hour {
		t.Fatal("retention", ttl, err)
	}
}

func TestRequestMetricsUnavailableDoesNotReplay(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", DialTimeout: 20 * time.Millisecond, ReadTimeout: 20 * time.Millisecond, WriteTimeout: 20 * time.Millisecond, MaxRetries: -1, ContextTimeoutEnabled: true})
	defer client.Close()
	m := &requestMetrics{pending: map[requestMetricKey]requestSample{}}
	s := &Server{Store: &Store{Redis: client}, requestMetrics: m}
	m.observe(requestMetricKey{time.Now().UnixMilli() / 60000 * 60000, "request", "other", "GET"}, time.Millisecond, 1, false, false, false)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	report, err := s.requestPerformance(&request{Server: s, R: httptest.NewRequest("GET", "/api/admin/performance", nil).WithContext(ctx)})
	if err != nil || boolean(obj(report)["available"]) || m.droppedBatches.Load() != 1 || len(m.pending) != 0 {
		t.Fatal("outage not reported, or uncertain batch retained", err)
	}
}
