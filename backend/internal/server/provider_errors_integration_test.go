package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

func runProviderErrorsIntegration(t *testing.T, s *Server, p *fixtureProvider, token string) {
	t.Run("provider errors across discovery and lifecycle", func(t *testing.T) {
		ctx := context.Background()
		defer func() { p.failure = nil }()
		call := func(method, path string, body any) *httptest.ResponseRecorder {
			raw, _ := json.Marshal(body)
			req := httptest.NewRequest(method, path, bytes.NewReader(raw))
			req.RemoteAddr = "198.51.100.6:1234"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		for i, c := range []struct {
			err    error
			code   string
			status int
		}{
			{provider.ErrNotFound, "resource_not_found", 404},
			{provider.ErrAccessDenied, "not_authorized", 403},
			{provider.ErrCapability, "provider_capability_not_supported", 400},
			{&provider.RateLimitError{ResetAt: time.UnixMilli(1800000000123)}, "rate_limited", 429},
			{provider.ErrUpstream, "upstream_error", 502},
			{errors.New("private upstream details"), "internal_error", 500},
		} {
			p.failure = fmt.Errorf("private endpoint and credential: %w", c.err)
			id := fmt.Sprintf("provider-error-%d", i)
			body := M{"gistId": id, "source": M{"provider": "fixture", "gistId": "snippet"}, "options": M{}, "terms": []any{}}
			for _, response := range []*httptest.ResponseRecorder{
				call("GET", "/api/providers/fixture/repository/metadata?name="+url.QueryEscape(p.name), nil),
				call("POST", "/api/gist", body),
			} {
				var result M
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if response.Code != c.status || result["error"] != c.code || strings.Contains(response.Body.String(), "private") {
					t.Fatal(response.Code, response.Body)
				}
				if c.code == "rate_limited" && number(result["resetAt"]) != 1800000000123 {
					t.Fatal(response.Body)
				}
			}
			current, err := s.Store.one(ctx, collection("gist"), M{"gistId": id})
			want := c.code
			if want == "internal_error" {
				want = "preparation_failed"
			}
			if err != nil || current == nil || current["status"] != "error" || current["statusMessage"] != want {
				t.Fatal("document failure not normalized", current, err)
			}
			if _, err := s.Store.update(ctx, collection("gist"), M{"_id": current["_id"]}, M{"$set": M{"status": "preparing"}}); err != nil {
				t.Fatal(err)
			}
			if err := s.runJob(ctx, M{"kind": "gist", "resourceId": id, "action": "prepare", "attempts": 3}); err == nil {
				t.Fatal("failed provider job succeeded")
			}
			current, err = s.Store.one(ctx, collection("gist"), M{"gistId": id})
			wantStatus := "error"
			if c.code == "rate_limited" {
				wantStatus = "queue"
				want = "rate_limited:1800000000123"
			}
			if err != nil || current["status"] != wantStatus || current["statusMessage"] != want {
				t.Fatal("job failure or quota delay not normalized", current, err)
			}
		}
	})
}
