package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGitHubQuotaSuppressesRequests(t *testing.T) {
	var calls atomic.Int64
	reset := time.Now().Add(time.Hour).Truncate(time.Second)
	s := &Server{HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		h := http.Header{}
		h.Set("X-RateLimit-Reset", strconv.FormatInt(reset.Unix(), 10))
		return &http.Response{StatusCode: 429, Header: h, Body: io.NopCloser(strings.NewReader("private upstream text"))}, nil
	})}}
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		_, err := s.github(ctx, "GET", "/repos/team/project", "synthetic-secret", nil)
		var api *APIError
		if !errors.As(err, &api) || api.Code != "github_rate_limit_exceeded" || api.ResetAt != reset.UnixMilli() {
			t.Fatalf("unexpected error: %+v", err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("gate allowed %d requests", calls.Load())
	}
	_, _ = s.github(ctx, "GET", "/repos/team/other", "different-secret", nil)
	if calls.Load() != 2 {
		t.Fatal("independent credential blocked")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	_, err := s.github(canceled, "GET", "/repos/team/project", "unused-secret", nil)
	if !errors.Is(err, context.Canceled) || calls.Load() != 2 {
		t.Fatal("canceled request dispatched", err)
	}
}

func TestGitHubQuotaSurvivesTokenRotation(t *testing.T) {
	s := &Server{}
	s.registerGitHubQuota("old-secret", "installation:app:42")
	s.registerGitHubQuota("new-secret", "installation:app:42")
	h := http.Header{}
	h.Set("Retry-After", "60")
	limited := s.recordGitHubQuota(context.Background(), "old-secret", h).(*APIError)
	var api *APIError
	if !errors.As(s.checkGitHubQuota(context.Background(), "new-secret"), &api) || api.ResetAt != limited.ResetAt {
		t.Fatal("renewal bypassed quota")
	}
	s.registerGitHubQuota("other-secret", "installation:app:43")
	if err := s.checkGitHubQuota(context.Background(), "other-secret"); err != nil {
		t.Fatal("different installation blocked", err)
	}
	for digest := range s.quotaScopes {
		if strings.Contains(digest, "secret") {
			t.Fatal("plaintext token retained")
		}
	}
}

func TestRawBlobQuotaClosesBodyAndSuppressesRetry(t *testing.T) {
	var calls atomic.Int64
	closed := false
	s := &Server{HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		h := http.Header{}
		h.Set("X-RateLimit-Remaining", "0")
		h.Set("Retry-After", "60")
		return &http.Response{StatusCode: 403, Header: h, Body: &revocationBody{Reader: strings.NewReader("private upstream body"), closed: &closed}}, nil
	})}}
	record := M{"source": M{"repositoryName": "team/project", "commit": strings.Repeat("a", 40)}}
	row := M{"name": "file.txt"}
	for i := 0; i < 2; i++ {
		body, err := s.rawBlob(context.Background(), record, row, "synthetic-raw-token")
		var api *APIError
		if body != nil || !errors.As(err, &api) || api.Status != 429 {
			t.Fatal("raw quota not normalized", err)
		}
	}
	if !closed || calls.Load() != 1 {
		t.Fatal("raw response leaked or retry dispatched", closed, calls.Load())
	}
}
