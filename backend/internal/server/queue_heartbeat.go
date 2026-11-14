package server

import (
	"context"
	"log/slog"
	"time"
)

// Sample independently of maintenance; a slow maintenance pass must not look
// like a dead queue. Each sample is bounded and samples cannot overlap.
func (s *Server) runQueueHeartbeats(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		s.logQueueHeartbeat(ctx, time.Now())
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) logQueueHeartbeat(ctx context.Context, now time.Time) {
	rows, err := s.queueHeartbeat(ctx, now)
	if err != nil {
		return
	} // Missing heartbeats report an unavailable queue store.
	for _, row := range rows {
		slog.InfoContext(ctx, "queue heartbeat", "module", "queue", "queue", row["queue"], "waiting", row["waiting"], "active", row["active"], "delayed", row["delayed"], "failed", row["failed"], "oldestWaitingMs", row["oldestWaitingMs"])
	}
}

func (s *Server) queueHeartbeat(ctx context.Context, now time.Time) ([]M, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	// Go represents timed retries as waiting with a future availableAt. Report
	// those as delayed, matching the Node queue dashboard and alert semantics.
	state := M{"$cond": []any{M{"$and": []any{M{"$eq": []any{"$state", "waiting"}}, M{"$gt": []any{"$availableAt", now}}}}, "delayed", "$state"}}
	cursor, err := s.Store.DB.Collection("gojobs").Aggregate(ctx, []M{
		{"$match": M{"state": M{"$in": []string{"waiting", "active", "delayed", "failed"}}, "action": M{"$in": []string{"prepare", "cache", "remove", "expire"}}}},
		{"$group": M{"_id": M{"action": "$action", "state": state}, "count": M{"$sum": 1}, "oldest": M{"$min": "$createdAt"}}},
	})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	groups := []M{}
	if err = cursor.All(ctx, &groups); err != nil {
		return nil, err
	}
	rows := []M{}
	byName := map[string]M{}
	for _, queue := range workerQueues {
		row := M{"queue": queue.name, "waiting": int64(0), "active": int64(0), "delayed": int64(0), "failed": int64(0), "oldestWaitingMs": int64(0)}
		rows = append(rows, row)
		byName[queue.name] = row
	}
	for _, group := range groups {
		id := obj(group["_id"])
		queue := "download"
		switch str(id["action"]) {
		case "cache":
			queue = "cache"
		case "remove", "expire":
			queue = "remove"
		}
		row := byName[queue]
		state := str(id["state"])
		row[state] = number(row[state]) + number(group["count"])
		if state == "waiting" {
			if oldest, ok := storedDate(group["oldest"]); ok {
				age := now.Sub(oldest).Milliseconds()
				if age > number(row["oldestWaitingMs"]) {
					row["oldestWaitingMs"] = age
				}
			}
		}
	}
	return rows, nil
}
