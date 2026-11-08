package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runQueueOverviewIntegration(t *testing.T, base *Server) {
	ctx := context.Background()
	db := base.Store.DB.Client().Database("queue_overview_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	options := *base.Store.Redis.Options()
	options.DB = 15
	client := redis.NewClient(&options)
	defer client.Close()
	if err := client.FlushDB(ctx).Err(); err != nil {
		t.Fatal(err)
	}
	defer client.FlushDB(ctx)
	s := &Server{Store: &Store{DB: db, Redis: client}}
	now := time.Now().UTC().Truncate(time.Millisecond)
	delayed := M{"_id": "delayed-fixture", "resourceId": "DelayedRepo", "kind": "repo", "action": "prepare", "state": "delayed", "createdAt": now.Add(-time.Hour), "availableAt": now.Add(time.Hour), "attempts": 2}
	completed := M{"_id": "completed-fixture", "resourceId": "DoneRepo", "kind": "repo", "action": "prepare", "state": "completed", "createdAt": now.Add(-time.Hour), "startedAt": now.Add(-time.Minute), "finishedAt": now, "attempts": 1}
	if _, err := db.Collection("gojobs").InsertMany(ctx, []any{delayed, completed}); err != nil {
		t.Fatal(err)
	}
	for _, queue := range []string{"download", "remove", "cache"} {
		key := fmt.Sprintf("qmetrics:%s:%d", queue, now.Add(-time.Minute).Truncate(time.Minute).UnixMilli())
		if err := client.HSet(ctx, key, "c", 7, "f", 2, "ms", 90).Err(); err != nil {
			t.Fatal(err)
		}
	}
	// Process samples distinguish actual worker loops from configured capacity,
	// exclude stale instances, and retain concurrency only when a worker exists.
	for _, fixture := range []struct {
		id    string
		age   time.Duration
		count int64
	}{{"live", 0, 3}, {"stopped", 0, 0}, {"stale", 91 * time.Second, 9}} {
		sample := M{"instance": "api:" + fixture.id, "runtime": "go", "service": "api", "sampledAt": now.Add(-fixture.age).UnixMilli(), "memory": M{}, "eventLoop": M{}, "queueWorkers": M{"download": fixture.count}}
		pipe := client.TxPipeline()
		writeProcessSample(ctx, pipe, sample)
		if _, err := pipe.Exec(ctx); err != nil {
			t.Fatal(err)
		}
	}
	request := func(query string) *request {
		return &request{Server: s, R: httptest.NewRequest("GET", "/api/admin/queues"+query, nil)}
	}
	raw, err := s.adminQueues(request("?queue=unknown"))
	if err != nil {
		t.Fatal(err)
	}
	report := obj(raw)
	if report["selectedQueue"] != "download" {
		t.Fatal(report)
	}
	for _, row := range report["queues"].([]M) {
		if number(row["completed24h"]) != 7 || number(row["failed24h"]) != 2 {
			t.Fatal(row)
		}
		if row["key"] == "download" {
			if number(row["workers"]) != 1 || number(row["concurrency"]) != 3 {
				t.Fatal(row)
			}
		} else if number(row["workers"]) != 0 || row["concurrency"] != nil {
			t.Fatal(row)
		}
	}
	jobs := report["jobs"].([]M)
	if len(jobs) != 2 || jobs[0]["_state"] != "delayed" || number(jobs[0]["delayUntil"]) != now.Add(time.Hour).UnixMilli() || number(jobs[1]["processedOn"]) != now.Add(-time.Minute).UnixMilli() || number(jobs[1]["finishedOn"]) != now.UnixMilli() {
		t.Fatal(jobs)
	}
	raw, err = s.adminQueues(request("?search=dELAyED"))
	if err != nil || len(obj(raw)["jobs"].([]M)) != 1 {
		t.Fatal(raw, err)
	}
	for _, tc := range []struct {
		query, selected string
		count           int
	}{
		{"?queue[]=remove", "remove", 0},
		{"?queue=remove&queue=cache", "download", 2},
		{"?search[]=dELAyED", "download", 1},
		{"?search=Delayed&search=Repo", "download", 0},
		{"?search[x]=Delayed", "download", 0},
	} {
		raw, err := s.adminQueues(request(tc.query))
		if err != nil || obj(raw)["selectedQueue"] != tc.selected || len(obj(raw)["jobs"].([]M)) != tc.count {
			t.Fatal(tc, raw, err)
		}
	}
	s.requestMetrics = &requestMetrics{instance: "api:live"}
	s.removeProcessSample(ctx)
	instances, err := s.readProcessInstances(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, instance := range instances {
		if instance["instance"] == "api:live" {
			t.Fatal("stopped instance still advertised")
		}
	}
	s.requestMetrics = nil
	// A paused worker still exists; cancellation removes its local presence.
	client.Set(ctx, "go:pause:download", "1", time.Minute)
	work, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); s.jobLoop(work, "download") }()
	deadline := time.Now().Add(2 * time.Second)
	for s.jobWorkerCounts[0].Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	sample := s.queueWorkerSample()
	cancel()
	<-done
	if number(sample["download"]) != 1 || s.jobWorkerCounts[0].Load() != 0 {
		t.Fatal(sample, s.jobWorkerCounts[0].Load())
	}
}
