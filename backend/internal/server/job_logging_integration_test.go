package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tdurieux/anonymous_github/backend/internal/logging"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type jobLogWriter struct {
	rows   []M
	cancel context.CancelFunc
	t      *testing.T
}

func (w *jobLogWriter) Write(data []byte) (int, error) {
	row := M{}
	if err := json.Unmarshal(data, &row); err != nil {
		w.t.Error(err)
	}
	if strings.Contains(string(data), "private-resource") {
		w.t.Error("resource identifier leaked")
	}
	w.rows = append(w.rows, row)
	if row["event"] == "job_completed" {
		w.cancel()
	}
	return len(data), nil
}

func runJobLoggingIntegration(t *testing.T, base *Server) {
	ctx := t.Context()
	db := base.Store.DB.Client().Database("job_logging_test_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	s := &Server{Store: &Store{DB: db, Redis: base.Store.Redis}}
	trace := newRequestTrace()
	requestCtx := context.WithValue(ctx, performanceContextKey{}, trace)
	if err := s.enqueue(requestCtx, "repo", "private-resource", "prepare"); err != nil {
		t.Fatal(err)
	}
	prior := slog.Default()
	defer slog.SetDefault(prior)
	var firstID string
	for attempt := int64(1); attempt <= 2; attempt++ {
		work, cancel := context.WithTimeout(ctx, 5*time.Second)
		output := &jobLogWriter{cancel: cancel, t: t}
		slog.SetDefault(slog.New(logging.New(output, slog.LevelInfo, "")))
		s.jobLoop(work, "download")
		cancel()
		if len(output.rows) != 2 || output.rows[0]["event"] != "job_started" || output.rows[1]["event"] != "job_completed" {
			t.Fatal(output.rows)
		}
		row := output.rows[1]
		id := str(row["jobId"])
		if _, err := uuid.Parse(id); err != nil || number(row["attempt"]) != attempt || row["requestId"] != trace.id {
			t.Fatal(row)
		}
		if attempt == 1 {
			firstID = id
		} else if firstID != id {
			t.Fatal("retry lost trace", firstID, id)
		}
		if _, err := s.Store.update(ctx, "gojobs", M{"_id": "repo:private-resource:prepare"}, M{"$set": M{"state": "waiting", "availableAt": time.Now()}}); err != nil {
			t.Fatal(err)
		}
	}
}
