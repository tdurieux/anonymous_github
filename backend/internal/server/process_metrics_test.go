package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestProcessSampleCadenceAndUnavailableMetrics(t *testing.T) {
	s := &Server{started: time.Now(), requestMetrics: &requestMetrics{instance: "api:test"}}
	now := time.Now()
	sample := s.processSample(now)
	if sample == nil || sample["runtime"] != "go" || obj(sample["eventLoop"])["p95Ms"] != nil || obj(sample["eventLoop"])["available"] != false {
		t.Fatal("Go sample misrepresents event-loop metrics")
	}
	if sample["cpuPercent"] != nil {
		t.Fatal("first CPU sample has no baseline")
	}
	if s.processSample(now.Add(time.Second)) != nil {
		t.Fatal("sampling frequency unbounded")
	}
	second := s.processSample(now.Add(16 * time.Second))
	if second == nil {
		t.Fatal("sample not refreshed")
	}
	if runtime.GOOS == "linux" {
		rss, ok := obj(second["memory"])["rss"].(uint64)
		if !ok || rss == 0 || second["cpuPercent"] == nil {
			t.Fatal("missing Linux process measurements")
		}
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		sockets := obj(processSockets())
		if number(sockets["listening"]) < 1 || number(sockets["descriptors"]) < 1 {
			t.Fatal("process-owned listening socket missing", sockets)
		}
	}
	if _, err := json.Marshal(second); err != nil {
		t.Fatal("invalid JSON sample", err)
	}
}

func runProcessMetricsIntegration(t *testing.T, base *Server) {
	ctx := context.Background()
	id := "api:test:" + bson.NewObjectID().Hex()
	s := &Server{Store: base.Store, started: time.Now(), requestMetrics: &requestMetrics{instance: id, pending: map[requestMetricKey]requestSample{}}}
	now := time.Now()
	stale := id + ":stale"
	base.Store.Redis.ZAdd(ctx, "performance:v1:instances", redis.Z{Score: float64(now.Add(-91 * time.Second).UnixMilli()), Member: stale})
	base.Store.Redis.Set(ctx, "performance:v1:instance:"+stale, `{"instance":"`+stale+`","memory":{},"eventLoop":{}}`, time.Minute)
	report, err := s.requestPerformance(&request{Server: s, R: httptest.NewRequest("GET", "/api/admin/performance", nil)})
	if err != nil || !boolean(obj(report)["available"]) {
		t.Fatal("process report unavailable", err)
	}
	found := false
	for _, v := range arr(obj(report)["instances"]) {
		row := obj(v)
		if row["instance"] == stale {
			t.Fatal("stale instance reported")
		}
		if row["instance"] == id {
			found = true
			if row["runtime"] != "go" {
				t.Fatal("runtime label missing")
			}
		}
	}
	if !found {
		t.Fatal("live instance missing")
	}
	series := false
	for _, v := range arr(obj(report)["runtimeSeries"]) {
		if obj(v)["instance"] == id {
			series = true
		}
	}
	if !series {
		t.Fatal("runtime history missing")
	}
	before, err := base.Store.Redis.LLen(ctx, "performance:v1:runtime:api").Result()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.flushRequestMetrics(ctx); err != nil {
		t.Fatal(err)
	}
	after, _ := base.Store.Redis.LLen(ctx, "performance:v1:runtime:api").Result()
	if after != before {
		t.Fatal("repeated report duplicated sample")
	}
	ttl, err := base.Store.Redis.TTL(ctx, "performance:v1:instance:"+id).Result()
	if err != nil || ttl <= 0 || ttl > 90*time.Second {
		t.Fatal("instance retention", ttl, err)
	}
}
