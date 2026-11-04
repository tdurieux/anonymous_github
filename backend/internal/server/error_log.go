package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
)

const errorLogMax = 5000
const errorLogBuffer = 128

var errorLogCode = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

type errorLogEvent struct {
	at                                   time.Time
	level, module, message, code, bucket string
	data                                 []byte
	skip                                 bool
}
type errorLogBufferState struct {
	mu      sync.Mutex
	flushMu sync.Mutex
	pending []errorLogEvent
	dropped atomic.Int64
}

func errorBucket(status int, level string) string {
	switch {
	case status >= 500:
		return "error"
	case status == 401 || status == 403 || status == 404:
		return "info"
	case status >= 400:
		return "warn"
	case level == "error":
		return "error"
	default:
		return "warn"
	}
}
func noisyError(code string) bool {
	switch code {
	case "repository_expired", "repository_not_ready", "repoId_already_used", "invalid_repoId", "page_not_supported_on_different_branch":
		return true
	}
	return false
}
func (s *Server) recordError(ctx context.Context, err error) {
	code, status := "server_error", 500
	var api *APIError
	if errors.As(providerFailure(err), &api) {
		code, status = api.Code, api.Status
	}
	if !errorLogCode.MatchString(code) {
		code = "server_error"
	}
	level := "error"
	if status >= 400 && status < 500 {
		level = "warn"
	}
	detail := M{"code": code, "httpStatus": status}
	if trace := traceFrom(ctx); trace != nil {
		detail["requestId"] = trace.id
	}
	s.enqueueError(level, "route", code, code, status, detail)
}

// Inputs are server-owned codes and fixed request fields, never upstream error
// text, request bodies, raw URLs, credentials or arbitrary provider metadata.
func (s *Server) enqueueError(level, module, message, code string, status int, detail M) {
	severity := slog.LevelError
	if level == "warn" {
		severity = slog.LevelWarn
	}
	if !slog.Default().Enabled(context.Background(), severity) {
		return
	}
	at := time.Now().UTC()
	bucket := errorBucket(status, level)
	data, err := json.Marshal(M{"ts": at, "module": module, "level": level, "message": message, "raw": []any{message, detail}})
	if err != nil || len(data) > 4096 {
		s.errorLog.dropped.Add(1)
		return
	}
	s.errorLog.mu.Lock()
	defer s.errorLog.mu.Unlock()
	if s.Store == nil || s.Store.Redis == nil || len(s.errorLog.pending) >= errorLogBuffer {
		s.errorLog.dropped.Add(1)
		return
	}
	s.errorLog.pending = append(s.errorLog.pending, errorLogEvent{at, level, module, message, code, bucket, data, bucket == "info" || noisyError(code)})
}
func (s *Server) flushErrorLog(ctx context.Context) error {
	s.errorLog.flushMu.Lock()
	defer s.errorLog.flushMu.Unlock()
	s.errorLog.mu.Lock()
	entries := s.errorLog.pending
	s.errorLog.pending = nil
	s.errorLog.mu.Unlock()
	if len(entries) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	pipe := s.Store.Redis.TxPipeline()
	for _, e := range entries {
		if !e.skip {
			pipe.LPush(ctx, "admin:errors", e.data)
			pipe.LTrim(ctx, "admin:errors", 0, errorLogMax-1)
		}
		key := "admin:errors:hourly:" + e.at.Format("2006010215")
		for _, field := range []string{"total", "bucket:" + e.bucket, "level:" + e.level, "module:" + e.module, "cb:" + e.bucket + ":" + e.code} {
			pipe.HIncrBy(ctx, key, field, 1)
		}
		pipe.Expire(ctx, key, 48*time.Hour)
	}
	_, err := pipe.Exec(ctx)
	// Never replay an uncertain transaction and duplicate entries/counters.
	if err != nil {
		s.errorLog.dropped.Add(int64(len(entries)))
	}
	return err
}

// The errors endpoint uses parseInt(value, 10), unlike general admin pagination.
func errorPageInt(value string, fallback int64) int64 {
	value = strings.TrimLeftFunc(value, func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' })
	negative := false
	if len(value) > 0 && (value[0] == '+' || value[0] == '-') {
		negative = value[0] == '-'
		value = value[1:]
	}
	var n int64
	digits := 0
	for _, c := range value {
		if c < '0' || c > '9' {
			break
		}
		digits++
		n = min(int64(9007199254740991), n*10+int64(c-'0'))
	}
	if digits == 0 || n == 0 {
		return fallback
	}
	if negative {
		return -n
	}
	return n
}
