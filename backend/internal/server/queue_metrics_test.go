package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

type queueMetricFixture struct {
	Now    int64
	Ranges []struct {
		Input          any
		Queue, Range   string
		Minutes, Count int64
		First, Last    queueMetricPoint
	}
	Durations []struct {
		Input float64
		Ms    int64
	}
}

func readQueueMetricFixture(t *testing.T) queueMetricFixture {
	t.Helper()
	data, err := os.ReadFile("testdata/queue-metrics.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture queueMetricFixture
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}
func TestQueueMetricRangeContracts(t *testing.T) {
	for _, row := range readQueueMetricFixture(t).Ranges {
		values := url.Values{}
		switch v := row.Input.(type) {
		case string:
			values.Set("range", v)
		case []any:
			for _, value := range v {
				values.Add("range", str(value))
			}
		}
		name, selected, minutes, err := queueMetricSelection(values.Encode())
		if err != nil {
			t.Fatal(err)
		}
		if name != row.Queue || selected != row.Range || minutes != row.Minutes {
			t.Fatal(row, name, selected, minutes)
		}
	}
	s := &Server{}
	result, err := s.queueMetrics(&request{R: httptest.NewRequest("GET", "/api/admin/queues/metrics?range=24h", nil)})
	if err != nil || obj(result)["range"] != "24h" || len(obj(result)["points"].([]queueMetricPoint)) != 0 {
		t.Fatal(result, err)
	}
	_, err = s.queueMetrics(&request{R: httptest.NewRequest("GET", "/api/admin/queues/metrics?queue=unknown", nil)})
	if err == nil || err.Error() != "queue_not_found" {
		t.Fatal(err)
	}
}
func runQueueMetricIntegration(t *testing.T, base *Server) {
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
	fixture := readQueueMetricFixture(t)
	now := time.UnixMilli(fixture.Now)
	key := "qmetrics:download:1800000000000"
	if err := client.HSet(ctx, key, "c", 2, "f", 1, "ms", 11).Err(); err != nil {
		t.Fatal(err)
	}
	for _, row := range fixture.Ranges {
		points := s.queueMetricPoints(ctx, row.Queue, row.Minutes, now)
		if int64(len(points)) != row.Count || !reflect.DeepEqual(points[0], row.First) || !reflect.DeepEqual(points[len(points)-1], row.Last) {
			t.Fatal("queue contract", row.Range, len(points))
		}
	}
	client.HSet(ctx, key, "ms", 30)
	cached := s.queueMetricPoints(ctx, "download", 60, now.Add(29*time.Second))
	if cached[len(cached)-1].AvgMs != 4 {
		t.Fatal("cache expired before 30 seconds")
	}
	fresh := s.queueMetricPoints(ctx, "download", 60, now.Add(31*time.Second))
	if fresh[len(fresh)-1].AvgMs != 10 {
		t.Fatal("cache failed to expire")
	}
	other := s.queueMetricPoints(ctx, "remove", 60, now)
	if other[len(other)-1].Completed != 0 {
		t.Fatal("cross-queue cache collision")
	}
	// Failed reads yield an empty chart and are retried on the next request.
	s.queueHistory.entries = nil
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if points := s.queueMetricPoints(canceled, "download", 60, now); len(points) != 0 {
		t.Fatal("failed Redis read returned partial chart")
	}
	if points := s.queueMetricPoints(ctx, "download", 60, now); len(points) != 60 {
		t.Fatal("failed chart cached")
	}
	for _, row := range fixture.Durations {
		s.queueMetric(ctx, M{"action": "cache"}, false, time.Duration(row.Input*float64(time.Millisecond)))
		keys, err := client.Keys(ctx, "qmetrics:cache:*").Result()
		if err != nil || len(keys) == 0 {
			t.Fatal(keys, err)
		}
		var ms, count int64
		for _, k := range keys {
			v := client.HGetAll(ctx, k).Val()
			ms += errorPageInt(v["ms"], 0)
			count += errorPageInt(v["c"], 0)
			ttl := client.TTL(ctx, k).Val()
			if ttl < 7*24*time.Hour || ttl > 7*24*time.Hour+time.Hour {
				t.Fatal(ttl)
			}
			client.Del(ctx, k)
		}
		if ms != row.Ms || count != 1 {
			t.Fatal(row, ms, count)
		}
	}
}
