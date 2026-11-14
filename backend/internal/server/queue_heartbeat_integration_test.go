package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/logging"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runQueueHeartbeatIntegration(t *testing.T, base *Server) {
	ctx := t.Context()
	db := base.Store.DB.Client().Database("queue_heartbeat_test_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	s := &Server{Store: &Store{DB: db, Redis: base.Store.Redis}}
	now := time.Now().Truncate(time.Millisecond)
	rows := []any{
		M{"action": "prepare", "state": "waiting", "createdAt": now.Add(-time.Minute), "availableAt": now, "resourceId": "private-repository"},
		M{"action": "prepare", "state": "waiting", "createdAt": now.Add(-time.Hour), "availableAt": now.Add(time.Minute)},
		M{"action": "prepare", "state": "active"}, M{"action": "prepare", "state": "failed"}, M{"action": "prepare", "state": "completed"},
		M{"action": "remove", "state": "waiting", "createdAt": now.Add(-time.Second)},
		M{"action": "expire", "state": "waiting", "createdAt": now.Add(-2 * time.Second)},
		M{"action": "cache", "state": "delayed"}, M{"action": "unknown", "state": "waiting"},
	}
	if _, err := db.Collection("gojobs").InsertMany(ctx, rows); err != nil {
		t.Fatal(err)
	}
	previous := slog.Default()
	defer slog.SetDefault(previous)
	var output bytes.Buffer
	slog.SetDefault(slog.New(logging.New(&output, slog.LevelInfo, "")))
	s.logQueueHeartbeat(ctx, now)
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 3 {
		t.Fatal(output.String())
	}
	counts := map[string]M{}
	for _, line := range lines {
		row := M{}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal(err)
		}
		counts[str(row["queue"])] = row
		if row["event"] != "queue_heartbeat" {
			t.Fatal(row)
		}
	}
	download := counts["download"]
	for _, key := range []string{"waiting", "active", "delayed", "failed"} {
		if number(download[key]) != 1 {
			t.Fatal(download)
		}
	}
	if number(download["oldestWaitingMs"]) != 60000 || number(counts["remove"]["oldestWaitingMs"]) != 2000 || number(counts["remove"]["waiting"]) != 2 || number(counts["cache"]["delayed"]) != 1 {
		t.Fatal(counts)
	}
	if strings.Contains(output.String(), "private") {
		t.Fatal(output.String())
	}
	output.Reset()
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	s.logQueueHeartbeat(cancelled, now)
	if output.Len() != 0 {
		t.Fatal("database failure emitted a healthy heartbeat", output.String())
	}
	if _, err := db.Collection("gojobs").DeleteMany(ctx, M{}); err != nil {
		t.Fatal(err)
	}
	s.logQueueHeartbeat(ctx, now)
	lines = strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 3 {
		t.Fatal("empty queues must still report heartbeats", output.String())
	}
	for _, line := range lines {
		row := M{}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"waiting", "active", "delayed", "failed", "oldestWaitingMs"} {
			if number(row[key]) != 0 {
				t.Fatal(row)
			}
		}
	}
}
