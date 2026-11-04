package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

func TestProviderErrorResponses(t *testing.T) {
	for _, c := range []struct {
		err    error
		code   string
		status int
	}{
		{provider.ErrBranchNotFound, "branch_not_found", 404},
		{provider.ErrUnknown, "provider_not_supported", 400},
		{provider.ErrCapability, "provider_capability_not_supported", 400},
		{provider.ErrNotFound, "resource_not_found", 404},
		{provider.ErrAccessDenied, "not_authorized", 403},
		{provider.ErrRateLimited, "rate_limited", 429},
		{&provider.RateLimitError{ResetAt: time.UnixMilli(1800000000123)}, "rate_limited", 429},
		{provider.ErrUpstream, "upstream_error", 502},
		{errors.New("private upstream details"), "internal_error", 500},
		{fail("existing_github_code", 422), "existing_github_code", 422},
	} {
		t.Run(c.code, func(t *testing.T) {
			for _, err := range []error{c.err, fmt.Errorf("private endpoint and credential: %w", c.err)} {
				w := httptest.NewRecorder()
				writeError(w, err)
				var body M
				if e := json.Unmarshal(w.Body.Bytes(), &body); e != nil {
					t.Fatal(e)
				}
				if w.Code != c.status || body["error"] != c.code || strings.Contains(w.Body.String(), "private") {
					t.Fatal(w.Code, w.Body)
				}
				var limit *provider.RateLimitError
				if errors.As(c.err, &limit) && number(body["resetAt"]) != 1800000000123 {
					t.Fatal(w.Body)
				}
				if w.Header().Get("Cache-Control") != "no-store" {
					t.Fatal(w.Header())
				}
			}
		})
	}
}
