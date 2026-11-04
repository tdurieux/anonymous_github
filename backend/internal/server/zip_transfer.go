package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"
)

func requestTimeout(r *http.Request) time.Duration {
	parts := strings.Split(strings.TrimSuffix(r.URL.Path, "/"), "/")
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && len(parts) == 5 && parts[1] == "api" && parts[2] == "repo" && parts[3] != "" && parts[4] == "zip" {
		return 30 * time.Minute
	}
	return 2 * time.Minute
}

func zipFailureReason(ctx context.Context, err error) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "request_deadline"
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return "client_cancelled"
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return "truncated_source"
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "io_timeout"
	}
	var api *APIError
	if errors.As(err, &api) && errorLogCode.MatchString(api.Code) {
		return api.Code
	}
	// Only our fixed internal codes may enter logs, never upstream messages,
	// file paths, redirect URLs or credentials.
	switch err.Error() {
	case "invalid_archive_trailer", "invalid_archive_path", "invalid_archive_root", "unsupported_archive_entry", "invalid_or_duplicate_archive_path", "duplicate_archive_metadata", "archive_metadata_missing", "archive_entry_size_mismatch":
		return err.Error()
	}
	return "archive_stream_failed"
}
func (s *Server) recordZIPFailure(ctx context.Context, stage string, err error) {
	reason := zipFailureReason(ctx, err)
	id := ""
	if trace := traceFrom(ctx); trace != nil {
		id = trace.id
	}
	slog.Warn("ZIP transfer stopped", "requestId", id, "stage", stage, "reason", reason)
	if ctx.Err() == nil {
		s.recordError(ctx, fail(reason, 502))
	}
}
