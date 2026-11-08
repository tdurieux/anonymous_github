package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"
)

func testCacheMetrics() *cacheMetrics {
	return &cacheMetrics{pending: map[cacheMetricKey]cacheSample{}, instance: "fixture"}
}
func TestCacheMetricContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/cache-metrics.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Input          any
		WindowMinutes  int
		Period, Cutoff int64
		Buckets        []float64
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		var values []string
		switch v := c.Input.(type) {
		case string:
			values = []string{v}
		case []any:
			for _, entry := range v {
				values = append(values, entry.(string))
			}
		}
		if got := cacheWindow(values); got != c.WindowMinutes {
			t.Errorf("%v: got %d want %d", c.Input, got, c.WindowMinutes)
		}
		if !reflect.DeepEqual(cacheLatencyBuckets, c.Buckets) {
			t.Fatal("latency bucket mismatch")
		}
	}
}
func TestCacheMetricBoundsAndPrivacy(t *testing.T) {
	s := &Server{cacheMetrics: testCacheMetrics()}
	ctx := context.WithValue(context.Background(), cacheTrafficKey{}, "private/repository")
	now := time.Now()
	s.observeCacheAt(ctx, "private/token", 10, time.Second, now)
	if len(s.cacheMetrics.pending) != 0 {
		t.Fatal("unrecognized label retained")
	}
	for i := 0; i < 513; i++ {
		s.observeCacheAt(ctx, "source_hit", -1, -time.Second, now.Add(time.Duration(i)*time.Minute))
	}
	if len(s.cacheMetrics.pending) != 512 || s.cacheMetrics.dropped.Load() != 1 {
		t.Fatal("unbounded pending metrics")
	}
	for key, value := range s.cacheMetrics.pending {
		if key.traffic != "background" || value.bytes != 0 || value.ms != 0 || value.buckets[0] != 1 {
			t.Fatal(key, value)
		}
	}
	s.cacheMetrics = testCacheMetrics()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				s.observeCacheAt(context.Background(), "source_hit", 1, time.Millisecond, now)
			}
		}()
	}
	wg.Wait()
	for _, v := range s.cacheMetrics.pending {
		if v.count != 2000 || v.bytes != 2000 || v.buckets[1] != 2000 {
			t.Fatal(v)
		}
	}
}
func TestCacheTraffic(t *testing.T) {
	for _, c := range []struct{ path, agent, want string }{{"/api/repo/x/file/a", "", "file"}, {"/w/x/a", "", "website"}, {"/api/repo/x/zip", "", "zip"}, {"/w/x/a", "Uptime Monitor", "monitor"}} {
		r := httptest.NewRequest("GET", c.path, nil)
		r.Header.Set("User-Agent", c.agent)
		r.Header.Set("X-Cache-Traffic", "private")
		if got := cacheTraffic(r); got != c.want {
			t.Fatal(c, got)
		}
	}
}

func BenchmarkCacheMetricRecording(b *testing.B) {
	s := &Server{cacheMetrics: testCacheMetrics()}
	ctx := context.WithValue(context.Background(), cacheTrafficKey{}, "file")
	b.ReportAllocs()
	for b.Loop() {
		s.observeCache(ctx, "source_hit", 4096, time.Millisecond)
	}
}
