package server

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProviderResolution(t *testing.T) {
	for _, c := range []struct {
		source M
		want   string
		fail   bool
	}{{M{}, "github", false}, {M{"type": "GitHubStream"}, "github", false}, {M{"type": "GitHubDownload"}, "github", false}, {M{"type": "Zip"}, "archive", false}, {M{"type": "Provider", "provider": "fixture"}, "fixture", false}, {M{"type": "Other"}, "", true}} {
		got, e := sourceProvider(c.source)
		if got != c.want || (e != nil) != c.fail {
			t.Fatalf("%v: %s %v", c.source, got, e)
		}
	}
	s := &Server{}
	if _, e := s.providerAccess(M{"source": M{"provider": "fixture"}, "providerAccess": M{"provider": "github"}}); e == nil {
		t.Fatal("accepted mismatched binding")
	}
}

func TestResourceStatusErrors(t *testing.T) {
	s := &Server{}
	for _, c := range []struct {
		kind, status, message, code string
		http                        int
	}{
		{"repo", "queue", "rate_limited:1790000000000", "rate_limited", 425},
		{"repo", "error", "repository_access_revoked", "repository_access_revoked", 500},
		{"gist", "error", "", "gist_not_available", 500},
		{"pr", "error", "", "pull_request_not_available", 500},
		{"repo", "removed", "", "repository_expired", 410},
	} {
		e := s.checkResource(context.Background(), c.kind, M{"status": c.status, "statusMessage": c.message})
		var api *APIError
		if !errors.As(e, &api) || api.Code != c.code || api.Status != c.http {
			t.Fatalf("%+v: %v", c, e)
		}
		if c.code == "rate_limited" {
			w := httptest.NewRecorder()
			writeError(w, e)
			if !strings.Contains(w.Body.String(), `"resetAt":1790000000000`) {
				t.Fatal(w.Body)
			}
		}
	}
}
