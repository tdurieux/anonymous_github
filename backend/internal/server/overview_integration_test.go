package server

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runOverviewIntegration(t *testing.T, base *Server) {
	ctx := context.Background()
	db := base.Store.DB.Client().Database("overview_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	options := *base.Store.Redis.Options()
	options.DB = 15
	redisClient := redis.NewClient(&options)
	defer redisClient.Close()
	if err := redisClient.FlushDB(ctx).Err(); err != nil {
		t.Fatal(err)
	}
	defer redisClient.FlushDB(ctx)
	s := &Server{Store: &Store{DB: db, Redis: redisClient}, started: time.Now()}
	now := time.Now()
	// Recent activity is independent of status and of the creation timestamp.
	for i, row := range []M{
		{"status": "ready", "anonymizeDate": now.Add(-48 * time.Hour), "lastView": now},
		{"status": "removed", "anonymizeDate": now, "lastView": now.Add(-48 * time.Hour)},
		{"status": "error", "anonymizeDate": now.Add(-23 * time.Hour), "lastView": now.Add(-23 * time.Hour), "statusDate": now},
		{"status": "ready", "anonymizeDate": now.Add(-25 * time.Hour), "lastView": now.Add(-25 * time.Hour)},
		{"status": "ready"},
	} {
		row["repoId"] = "overview-" + string(rune('a'+i))
		if _, err := db.Collection(collection("repo")).InsertOne(ctx, row); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []M{{"dateOfEntry": now}, {"dateOfEntry": now.Add(-23 * time.Hour)}, {"dateOfEntry": now.Add(-25 * time.Hour)}, {}} {
		if _, err := db.Collection("users").InsertOne(ctx, row); err != nil {
			t.Fatal(err)
		}
	}

	today := now.UTC().Truncate(24 * time.Hour)
	for _, at := range []time.Time{today.AddDate(0, 0, -30), today.AddDate(0, 0, -29), today.AddDate(0, 0, -1), today.Add(12 * time.Hour)} {
		if _, err := db.Collection("dailystats").InsertOne(ctx, M{"date": at, "nbRepositories": 999, "nbUsers": 999, "nbPageViews": 999, "nbPullRequests": 999}); err != nil {
			t.Fatal(err)
		}
	}
	if err := redisClient.Set(ctx, publicStatsKey, `{"nbRepositories":999,"nbUsers":999,"nbPageViews":999,"nbPullRequests":999}`, time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	result, err := s.overview(&request{Server: s, R: httptest.NewRequest("GET", "/api/admin/overview?days=1", nil)})
	if err != nil {
		t.Fatal(err)
	}
	repos, users := obj(obj(result)["repos"]), obj(obj(result)["users"])
	for key, want := range map[string]int64{"total": 5, "activeRepos24h": 2, "newRepos24h": 2, "recentErrors24h": 1} {
		if number(repos[key]) != want {
			t.Fatalf("repos.%s = %v, want %d", key, repos[key], want)
		}
	}
	if number(users["total"]) != 4 || number(users["newUsers24h"]) != 2 {
		t.Fatalf("user counts: %v", users)
	}
	history := obj(result)["history"].([]M)
	if len(history) != 3 || !date(history[0]["date"]).Equal(today.AddDate(0, 0, -29)) || !date(history[2]["date"]).Equal(today) || number(history[2]["nbRepositories"]) != 5 {
		t.Fatal("admin history used stale cache, caller window or duplicate today", history)
	}
	if len(obj(obj(result)["errors"])) != 2 {
		t.Fatal("overview error-summary shape", obj(result)["errors"])
	}

	// Optional error counters must not take down the overview on malformed or
	// unavailable telemetry, matching TypeScript's independent best-effort block.
	key := "admin:errors:hourly:" + time.Now().UTC().Format("2006010215")
	if err := redisClient.Set(ctx, key, "invalid-history-type", time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	degraded, err := s.overview(&request{Server: s, R: httptest.NewRequest("GET", "/api/admin/overview", nil)})
	if err != nil || number(obj(obj(degraded)["errors"])["last24h"]) != 0 {
		t.Fatal("optional errors broke overview", degraded, err)
	}

}
