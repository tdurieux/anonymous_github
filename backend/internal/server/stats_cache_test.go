package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestPublicStatsWindowContracts(t *testing.T) {
	data, err := os.ReadFile("testdata/stats-window.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Input    any
		Expected int64
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, row := range cases {
		input := str(row.Input)
		if values, ok := row.Input.([]any); ok {
			parts := []string{}
			for _, v := range values {
				parts = append(parts, str(v))
			}
			input = strings.Join(parts, ",")
		}
		if got := publicStatsDays(input); got != row.Expected {
			t.Fatal(row, got)
		}
	}
}
func TestPublicStatsCacheCoalescingExpiryAndFailure(t *testing.T) {
	now := time.Now()
	cache := statsCache{now: func() time.Time { return now }}
	var calls atomic.Int64
	start, release := make(chan struct{}), make(chan struct{})
	var group sync.WaitGroup
	for i := 0; i < 16; i++ {
		group.Go(func() {
			value, err := cache.get(context.Background(), "one", 1, func() (any, error) {
				if calls.Add(1) == 1 {
					close(start)
				}
				<-release
				return 7, nil
			})
			if err != nil || value != 7 {
				t.Error(value, err)
			}
		})
	}
	<-start
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.get(canceled, "one", 1, func() (any, error) { t.Error("duplicate fill"); return nil, nil }); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	close(release)
	group.Wait()
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
	now = now.Add(time.Hour)
	if _, err := cache.get(context.Background(), "one", 1, func() (any, error) { calls.Add(1); return nil, errors.New("failed") }); err == nil {
		t.Fatal("failure swallowed")
	}
	value, err := cache.get(context.Background(), "one", 1, func() (any, error) { calls.Add(1); return 9, nil })
	if err != nil || value != 9 || calls.Load() != 3 {
		t.Fatal(value, err, calls.Load())
	}
	bounded := statsCache{}
	for i := 0; i < 20; i++ {
		bounded.get(context.Background(), strconv.Itoa(i), 16, func() (any, error) { return i, nil })
	}
	if len(bounded.entries) != 16 || bounded.entries["0"] != nil || bounded.entries["19"] == nil {
		t.Fatal("cache capacity/FIFO")
	}
}
func TestPublicStatsCachePanicDoesNotStrandWaiters(t *testing.T) {
	cache := statsCache{}
	func() {
		defer func() {
			if recover() == nil {
				t.Error("panic swallowed")
			}
		}()
		cache.get(context.Background(), "one", 1, func() (any, error) { panic("fixture") })
	}()
	value, err := cache.get(context.Background(), "one", 1, func() (any, error) { return 1, nil })
	if err != nil || value != 1 {
		t.Fatal(value, err)
	}
}
func runPublicStatsIntegration(t *testing.T, base *Server) {
	ctx := context.Background()
	db := base.Store.DB.Client().Database("stats_" + bson.NewObjectID().Hex())
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
	defer s.closeStatsCache()
	zero, err := s.getCurrentStats(ctx)
	if err != nil || number(zero["nbRepositories"]) != 0 {
		t.Fatal(zero, err)
	}
	if _, err := db.Collection(collection("repo")).InsertOne(ctx, M{"repoId": "fixture", "owner": "one", "pageView": 4}); err != nil {
		t.Fatal(err)
	}
	cached, err := s.getCurrentStats(ctx)
	if err != nil || number(cached["nbRepositories"]) != 0 {
		t.Fatal("zero cache not reused", cached, err)
	}
	cached["nbRepositories"] = 99
	cached, _ = s.getCurrentStats(ctx)
	if number(cached["nbRepositories"]) != 0 {
		t.Fatal("caller mutated cached totals")
	}
	// A second process reuses the TypeScript Redis key.
	other := &Server{Store: s.Store}
	defer other.closeStatsCache()
	shared, err := other.getCurrentStats(ctx)
	if err != nil || number(shared["nbRepositories"]) != 0 {
		t.Fatal("shared cache", shared, err)
	}
	if ttl := client.TTL(ctx, publicStatsKey).Val(); ttl < 59*time.Minute || ttl > time.Hour {
		t.Fatal(ttl)
	}
	// Corrupt cache entries are recomputed; a foreign lease is respected.
	client.Set(ctx, publicStatsKey, "invalid", time.Hour)
	fresh := &Server{Store: s.Store}
	defer fresh.closeStatsCache()
	value, err := fresh.getCurrentStats(ctx)
	if err != nil || number(value["nbRepositories"]) != 1 || number(value["nbPageViews"]) != 4 {
		t.Fatal(value, err)
	}
	if client.Exists(ctx, publicStatsLease).Val() != 0 {
		t.Fatal("lease leaked")
	}
	client.Del(ctx, publicStatsKey)
	client.Set(ctx, publicStatsLease, "node-owner", time.Second)
	publication := make(chan struct{})
	go func() {
		defer close(publication)
		time.Sleep(50 * time.Millisecond)
		client.Set(ctx, publicStatsKey, `{"nbRepositories":17,"nbUsers":2,"nbPageViews":40,"nbPullRequests":3}`, time.Hour)
	}()
	follower := &Server{Store: s.Store}
	defer follower.closeStatsCache()
	value, err = follower.getCurrentStats(ctx)
	<-publication
	if err != nil || number(value["nbRepositories"]) != 17 || client.Get(ctx, publicStatsLease).Val() != "node-owner" {
		t.Fatal("foreign lease not respected", value, err)
	}
	client.Del(ctx, publicStatsLease, publicStatsKey)
	// A Redis user can acquire the lease but cannot publish the cached totals.
	username := "stats_" + bson.NewObjectID().Hex()
	password := bson.NewObjectID().Hex()
	if err := client.Do(ctx, "ACL", "SETUSER", username, "reset", "on", ">"+password, "+@connection", "(+@all ~perf:lease:*)", "(+get ~perf:home-stats:v1)").Err(); err != nil {
		t.Fatal(err)
	}
	defer client.Do(ctx, "ACL", "DELUSER", username)
	restrictedOptions := options
	restrictedOptions.Username = username
	restrictedOptions.Password = password
	restricted := redis.NewClient(&restrictedOptions)
	defer restricted.Close()
	writeFailure := &Server{Store: &Store{DB: db, Redis: restricted}}
	defer writeFailure.closeStatsCache()
	value, err = writeFailure.getCurrentStats(ctx)
	if err != nil || number(value["nbRepositories"]) != 1 || client.Exists(ctx, publicStatsKey).Val() != 0 {
		t.Fatal("optional cache write failed request", value, err)
	}
	// No Redis service: database output and the local history cache still work.
	offlineClient := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	defer offlineClient.Close()
	offline := &Server{Store: &Store{DB: db, Redis: offlineClient}}
	defer offline.closeStatsCache()
	start := time.Now()
	value, err = offline.getCurrentStats(ctx)
	if err != nil || number(value["nbRepositories"]) != 1 || time.Since(start) > 3*time.Second {
		t.Fatal("Redis outage fallback", value, err, time.Since(start))
	}
	now := time.Now().UTC()
	today := now.Truncate(24 * time.Hour)
	history, err := offline.getStatsHistory(ctx, 30, now)
	if err != nil || len(history) != 1 {
		t.Fatal(history, err)
	}
	history[0]["nbRepositories"] = 999
	db.Collection("dailystats").InsertOne(ctx, M{"date": today.AddDate(0, 0, -1), "nbRepositories": 42})
	again, err := offline.getStatsHistory(ctx, 30, now)
	if err != nil || len(again) != 1 || number(again[0]["nbRepositories"]) != 1 {
		t.Fatal("history cache mutation/reuse", again, err)
	}
	next, err := offline.getStatsHistory(ctx, 30, now.Add(24*time.Hour))
	if err != nil || len(next) != 2 {
		t.Fatal("day rollover reused previous history", next, err)
	}
	// A unique date index permits multiple timestamps per day. The TypeScript
	// query returns all matching snapshots, including future-dated imports.
	if _, err := db.Collection("dailystats").DeleteMany(ctx, M{}); err != nil {
		t.Fatal(err)
	}
	docs := make([]any, 0, 402)
	for i := 0; i < 400; i++ {
		docs = append(docs, M{"date": today.Add(-24 * time.Hour).Add(time.Duration(i) * time.Second), "nbRepositories": i, "nbUsers": 1, "nbPageViews": i, "nbPullRequests": 0})
	}
	docs = append(docs, M{"date": today.Add(24 * time.Hour), "nbRepositories": 401}, M{"date": today.AddDate(0, 0, -31), "nbRepositories": -1})
	if _, err := db.Collection("dailystats").InsertMany(ctx, docs); err != nil {
		t.Fatal(err)
	}
	large, err := offline.getStatsHistory(ctx, 7, now)
	if err != nil || len(large) != 402 {
		t.Fatalf("history truncated: rows=%d error=%v", len(large), err)
	}
	for i := 0; i < 400; i++ {
		if number(large[i]["nbRepositories"]) != int64(i) {
			t.Fatalf("snapshot %d missing or out of order: %v", i, large[i])
		}
	}
	if !date(large[400]["date"]).Equal(today) || number(large[400]["nbRepositories"]) != 1 || number(large[401]["nbRepositories"]) != 401 {
		t.Fatal("current/future snapshots omitted", large[400:])
	}
	for _, tc := range []struct {
		query string
		count int
	}{
		{"days[]=7&days[]=30", 402}, {"days[1]=7&days[0]=1", 2},
		{"days[]=1&days=7", 2}, {"days=7&days[]=1", 402},
	} {
		result, err := offline.stats(&request{R: httptest.NewRequest("GET", "/api/stat/history?"+tc.query, nil)})
		if err != nil || len(result.([]M)) != tc.count {
			t.Fatalf("history query %q: %v, error=%v", tc.query, result, err)
		}
	}
}
