package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runGitHubQuotaIntegration(t *testing.T, base *Server) {
	t.Run("GitHub quotas shared across instances and token renewal", func(t *testing.T) {
		ctx := context.Background()
		scope := "installation:test:" + bson.NewObjectID().Hex()
		var calls atomic.Int64
		client := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			calls.Add(1)
			h := http.Header{}
			h.Set("Retry-After", "120")
			return &http.Response{StatusCode: 429, Header: h, Body: io.NopCloser(strings.NewReader("private details"))}, nil
		})}
		first := &Server{Store: base.Store, HTTP: client}
		second := &Server{Store: base.Store, HTTP: client}
		first.registerGitHubQuota("synthetic-original", scope)
		second.registerGitHubQuota("synthetic-renewed", scope)
		_, err := first.github(ctx, "GET", "/repos/team/project", "synthetic-original", nil)
		var firstAPI *APIError
		if !errors.As(err, &firstAPI) || firstAPI.Status != 429 {
			t.Fatal(err)
		}
		_, err = second.github(ctx, "GET", "/repos/team/other", "synthetic-renewed", nil)
		var secondAPI *APIError
		if !errors.As(err, &secondAPI) || secondAPI.ResetAt != firstAPI.ResetAt || calls.Load() != 1 {
			t.Fatal("shared quota bypassed", err, calls.Load())
		}
		second.registerGitHubQuota("synthetic-independent", scope+":other")
		_, _ = second.github(ctx, "GET", "/repos/team/other", "synthetic-independent", nil)
		if calls.Load() != 2 {
			t.Fatal("unrelated installation blocked")
		}
	})
}
