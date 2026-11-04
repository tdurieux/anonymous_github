package server

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Keep GitHub header interpretation in its adapter; jobs consume only the
// normalized reset instant used by other providers' RateLimitError values.
func githubRateLimit(header http.Header, now time.Time) error {
	var reset time.Time
	if seconds, err := strconv.ParseInt(header.Get("X-RateLimit-Reset"), 10, 64); err == nil && seconds > 0 && seconds <= 253402300799 {
		reset = time.Unix(seconds, 0)
	}
	retry := strings.TrimSpace(header.Get("Retry-After"))
	if seconds, err := strconv.ParseInt(retry, 10, 64); err == nil && seconds > 0 && seconds <= int64((1<<63-1)/time.Second) {
		if candidate := now.Add(time.Duration(seconds) * time.Second); candidate.After(reset) {
			reset = candidate
		}
	} else if candidate, err := http.ParseTime(retry); err == nil && candidate.After(reset) {
		reset = candidate
	}
	if !reset.After(now) {
		reset = now.Add(time.Minute)
	}
	return &APIError{Code: "github_rate_limit_exceeded", Status: 429, ResetAt: reset.UnixMilli()}
}
