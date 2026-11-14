package main

import (
	"context"
	"log/slog"
	"testing"
)

func TestLoggingThreshold(t *testing.T) {
	original := slog.Default()
	defer slog.SetDefault(original)
	for _, row := range []struct {
		env, level string
		want       slog.Level
	}{{"production", "", slog.LevelInfo}, {"development", "", slog.LevelDebug}, {"production", "WARN", slog.LevelWarn}, {"production", "error", slog.LevelError}, {"production", "invalid", slog.LevelInfo}} {
		t.Setenv("NODE_ENV", row.env)
		t.Setenv("LOG_LEVEL", row.level)
		configureLogging()
		if !slog.Default().Enabled(context.Background(), row.want) || slog.Default().Enabled(context.Background(), row.want-1) {
			t.Fatal(row)
		}
	}
}
