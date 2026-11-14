package server

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

func TestJobRateLimit(t *testing.T) {
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	future := now.Add(2 * time.Hour)
	for _, c := range []struct {
		name    string
		err     error
		reset   time.Time
		limited bool
	}{
		{"provider", &provider.RateLimitError{ResetAt: future}, future, true},
		{"wrapped", fmt.Errorf("private details: %w", &provider.RateLimitError{ResetAt: future}), future, true},
		{"unknown reset", provider.ErrRateLimited, now.Add(time.Minute), true},
		{"past reset", &provider.RateLimitError{ResetAt: now.Add(-time.Minute)}, now.Add(time.Minute), true},
		{"github", &APIError{Code: "github_rate_limit_exceeded", Status: 429, ResetAt: future.UnixMilli()}, future, true},
		{"upstream", provider.ErrUpstream, time.Time{}, false},
		{"access", provider.ErrAccessDenied, time.Time{}, false},
		{"untyped", errors.New("rate limit private details"), time.Time{}, false},
		{"success", nil, time.Time{}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			reset, limited := jobRateLimit(M{"action": "prepare"}, c.err, now)
			if limited != c.limited || !reset.Equal(c.reset) {
				t.Fatalf("reset=%v limited=%v", reset, limited)
			}
			if _, limited := jobRateLimit(M{"action": "remove"}, c.err, now); limited {
				t.Fatal("delayed removal")
			}
		})
	}
}

func TestGitHubRateLimitReset(t *testing.T) {
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		name, reset, retry string
		delay              time.Duration
	}{
		{"primary", strconv.FormatInt(now.Add(time.Hour).Unix(), 10), "", time.Hour},
		{"secondary", "", "120", 2 * time.Minute},
		{"http date", "", now.Add(3 * time.Minute).Format(http.TimeFormat), 3 * time.Minute},
		{"later limit", strconv.FormatInt(now.Add(time.Hour).Unix(), 10), "120", time.Hour},
		{"later retry", strconv.FormatInt(now.Add(time.Minute).Unix(), 10), "120", 2 * time.Minute},
		{"missing", "", "", time.Minute},
		{"past", "1", "-2", time.Minute},
		{"overflow", "9223372036854775807", "9223372036854775807", time.Minute},
		{"invalid", "private-token", "NaN", time.Minute},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := http.Header{}
			h.Set("X-RateLimit-Reset", c.reset)
			h.Set("Retry-After", c.retry)
			var api *APIError
			err := githubRateLimit(h, now)
			if !errors.As(err, &api) || api.ResetAt != now.Add(c.delay).UnixMilli() || api.Status != 429 || api.Code != "github_rate_limit_exceeded" {
				t.Fatalf("unexpected error: %+v", api)
			}
		})
	}
}

func TestImportedJobRetryPolicies(t *testing.T) {
	for _, c := range []struct {
		name     string
		job      M
		attempts int64
		delay    time.Duration
	}{
		{"Go default", M{"attempts": 2}, 3, 2 * time.Second},
		{"Bull default", M{"attempts": 1, "maxAttempts": 1}, 1, 0},
		{"fixed", M{"attempts": 3, "maxAttempts": 5, "backoffType": "fixed", "backoffDelay": 250}, 5, 250 * time.Millisecond},
		{"exponential", M{"attempts": 4, "maxAttempts": 5, "backoffType": "exponential", "backoffDelay": 250}, 5, 2 * time.Second},
		{"bounded overflow", M{"attempts": 1000000, "maxAttempts": 1000001, "backoffType": "exponential", "backoffDelay": 250}, 1000001, time.Duration(int64((1<<63-1)/time.Millisecond)) * time.Millisecond},
	} {
		t.Run(c.name, func(t *testing.T) {
			if jobMaxAttempts(c.job) != c.attempts || jobBackoff(c.job) != c.delay {
				t.Fatal(jobMaxAttempts(c.job), jobBackoff(c.job))
			}
		})
	}
}
