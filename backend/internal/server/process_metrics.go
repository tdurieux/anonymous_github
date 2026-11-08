package server

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

func boundedMetricFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, limit))
}

func containerMemoryLimit() any {
	for _, path := range []string{"/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"} {
		data, err := boundedMetricFile(path, 128)
		if err != nil {
			continue
		}
		n, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
		if err == nil && n > 0 && n < 9007199254740991 {
			return n
		}
	}
	return nil
}

// Called only while holding requestMetrics.flushMu; sampling is at most once
// every 15 seconds even when an administrator refreshes the report repeatedly.
func (s *Server) processSample(now time.Time) M {
	m := s.requestMetrics
	if m.instance == "" || (!m.sampledAt.IsZero() && now.Sub(m.sampledAt) < 15*time.Second) {
		return nil
	}
	var cpu any
	if seconds, ok := processCPUSeconds(); ok {
		if !m.cpuAt.IsZero() && now.After(m.cpuAt) && seconds >= m.cpuSeconds {
			cpu = (seconds - m.cpuSeconds) / now.Sub(m.cpuAt).Seconds() * 100
		}
		m.cpuAt, m.cpuSeconds = now, seconds
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	system := systemOverview(s.started)
	var workers any
	if s.pool != nil {
		workers = s.pool.Stats()
	}
	uptime := float64(0)
	if !s.started.IsZero() {
		uptime = now.Sub(s.started).Seconds()
	}
	sample := M{"instance": m.instance, "service": "api", "runtime": "go", "sampledAt": now.UnixMilli(), "uptime": uptime, "cpuPercent": cpu, "memoryLimitBytes": containerMemoryLimit(), "memory": M{"rss": system["processRss"], "heapUsed": memory.HeapAlloc, "heapTotal": memory.HeapSys, "external": nil}, "activeRequests": m.active.Load(), "sockets": processSockets(), "workers": workers, "goroutines": runtime.NumGoroutine(), "queueWorkers": s.queueWorkerSample(), "eventLoop": M{"available": false, "p95Ms": nil, "maxMs": nil, "utilization": nil}, "droppedMetrics": m.dropped.Load(), "droppedBatches": m.droppedBatches.Load(), "lastFlushAt": nil}
	if !m.lastFlush.IsZero() {
		sample["lastFlushAt"] = m.lastFlush.UnixMilli()
	}
	m.sampledAt = now
	return sample
}

func writeProcessSample(ctx context.Context, pipe redis.Pipeliner, sample M) {
	data, err := json.Marshal(sample)
	if err != nil {
		return
	}
	id := str(sample["instance"])
	at := number(sample["sampledAt"])
	pipe.Set(ctx, "performance:v1:instance:"+id, data, 90*time.Second)
	pipe.ZAdd(ctx, "performance:v1:instances", redis.Z{Score: float64(at), Member: id})
	pipe.ZRemRangeByScore(ctx, "performance:v1:instances", "0", strconv.FormatInt(at-90000, 10))
	pipe.Expire(ctx, "performance:v1:instances", 120*time.Second)
	pipe.LPush(ctx, "performance:v1:runtime:api", string(data))
	pipe.LTrim(ctx, "performance:v1:runtime:api", 0, 239)
	pipe.Expire(ctx, "performance:v1:runtime:api", 2*time.Hour)
}

func (s *Server) readProcessSamples(ctx context.Context, now time.Time, minutes int64) ([]M, []M, error) {
	instances, err := s.readProcessInstances(ctx, now)
	if err != nil {
		return nil, nil, err
	}
	series := []M{}
	for _, service := range []string{"api", "streamer"} {
		limit := int64(239)
		if service == "streamer" {
			limit = 959
		}
		values, err := s.Store.Redis.LRange(ctx, "performance:v1:runtime:"+service, 0, limit).Result()
		if err != nil {
			return nil, nil, err
		}
		for _, raw := range values {
			var sample M
			if json.Unmarshal([]byte(raw), &sample) != nil || number(sample["sampledAt"]) < now.UnixMilli()-minutes*60000 {
				continue
			}
			memory, loop, sockets, workers := obj(sample["memory"]), obj(sample["eventLoop"]), obj(sample["sockets"]), obj(sample["workers"])
			series = append(series, M{"instance": sample["instance"], "service": service, "sampledAt": sample["sampledAt"], "rss": memory["rss"], "heapUsed": memory["heapUsed"], "external": memory["external"], "cpuPercent": sample["cpuPercent"], "loopP95Ms": loop["p95Ms"], "sockets": sockets["descriptors"], "closeWait": sockets["closeWait"], "waiting": number(workers["waiting"]), "reservedBytes": number(workers["reservedBytes"])})
		}
	}
	return instances, series, nil
}

func (s *Server) readProcessInstances(ctx context.Context, now time.Time) ([]M, error) {
	ids, err := s.Store.Redis.ZRangeByScore(ctx, "performance:v1:instances", &redis.ZRangeBy{Min: strconv.FormatInt(now.UnixMilli()-90000, 10), Max: "+inf", Offset: 0, Count: 32}).Result()
	if err != nil {
		return nil, err
	}
	instances := []M{}
	if len(ids) > 0 {
		keys := make([]string, len(ids))
		for i, id := range ids {
			keys[i] = "performance:v1:instance:" + id
		}
		values, err := s.Store.Redis.MGet(ctx, keys...).Result()
		if err != nil {
			return nil, err
		}
		for _, raw := range values {
			var row M
			if text, ok := raw.(string); ok && json.Unmarshal([]byte(text), &row) == nil && row["memory"] != nil && row["eventLoop"] != nil {
				instances = append(instances, row)
			}
		}
	}

	return instances, nil
}

func (s *Server) removeProcessSample(ctx context.Context) {
	if s.requestMetrics == nil || s.requestMetrics.instance == "" {
		return
	}
	pipe := s.Store.Redis.TxPipeline()
	pipe.Del(ctx, "performance:v1:instance:"+s.requestMetrics.instance)
	pipe.ZRem(ctx, "performance:v1:instances", s.requestMetrics.instance)
	pipe.Exec(ctx)
}
func (s *Server) queueWorkerSample() M {
	out := M{}
	for i, queue := range workerQueues {
		out[queue.name] = s.jobWorkerCounts[i].Load()
	}
	return out
}
