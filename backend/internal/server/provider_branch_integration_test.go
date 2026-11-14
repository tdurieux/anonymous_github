package server

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"io"
	"net/http"
	"strings"
	"testing"
)

func runGitHubBranchIntegration(t *testing.T, s *Server, owner any) {
	t.Run("GitHub branches paginate and cannot resolve tags", func(t *testing.T) {
		old := s.HTTP
		defer func() { s.HTTP = old }()
		sha := strings.Repeat("b", 40)
		commits := 0
		pages := 0
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			var payload any
			headers := http.Header{}
			switch r.URL.Path {
			case "/repos/owner/repo/branches":
				pages++
				rows := []M{}
				if r.URL.Query().Get("page") == "1" {
					headers.Set("Link", `<https://api.github.com/repos/owner/repo/branches?per_page=100&page=2>; rel="next"`)
					for i := 0; i < 100; i++ {
						rows = append(rows, M{"name": "other", "commit": M{"sha": sha}})
					}
				} else {
					rows = append(rows, M{"name": "release", "commit": M{"sha": sha}})
				}
				payload = rows
			case "/repos/owner/repo/commits/" + sha:
				commits++
				payload = M{"sha": sha, "commit": M{"author": M{"date": "2025-01-01T00:00:00Z"}, "committer": M{"date": "2026-01-01T00:00:00Z"}}}
			default:
				t.Errorf("unexpected reference lookup: %s", r.URL.Path)
				payload = M{}
			}
			raw, _ := json.Marshal(payload)
			return &http.Response{StatusCode: 200, Header: headers, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
		})}
		g := &githubProvider{s}
		a := provider.Access{OwnerID: str(owner), Ref: provider.Ref{Provider: "github", Name: "owner/repo"}, Binding: map[string]any{"kind": "oauth"}}
		c, e := g.Branch(context.Background(), a, "release")
		if e != nil || c.ID != sha || c.Date.Year() != 2025 || pages != 2 || commits != 1 {
			t.Fatal(c, e, pages, commits)
		}
		_, e = g.Branch(context.Background(), a, "tag-only")
		if !errors.Is(e, provider.ErrBranchNotFound) || commits != 1 {
			t.Fatal("missing branch treated as a commit/tag", e, commits)
		}
	})
}
