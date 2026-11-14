package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

func runGitHubMetadataIntegration(t *testing.T, s *Server, owner any) {
	t.Run("GitHub file metadata recovery", func(t *testing.T) {
		old := s.HTTP
		defer func() { s.HTTP = old }()
		commit := strings.Repeat("a", 40)
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			if r.URL.Query().Get("ref") != commit || r.Header.Get("Authorization") == "" {
				t.Fatal("unpinned or unauthorized metadata lookup")
			}
			status := 200
			var body any = M{"type": "file", "sha": strings.Repeat("b", 40), "size": 19}
			switch r.URL.Path {
			case "/repos/owner/repo/contents/docs/a b.txt":
			case "/repos/owner/repo/contents/missing":
				status = 404
				body = M{"message": "Not Found"}
			case "/repos/owner/repo/contents/directory":
				body = []M{}
			case "/repos/owner/repo/contents/denied":
				status = 403
				body = M{"message": "Forbidden"}
			default:
				t.Fatal("unexpected path", r.URL.Path)
			}
			raw, _ := json.Marshal(body)
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
		})}
		g := &githubProvider{s}
		a := provider.Access{OwnerID: str(owner), Ref: provider.Ref{Provider: "github", Name: "owner/repo", Commit: commit}, Binding: map[string]any{"kind": "oauth"}}
		entry, err := g.FileMetadata(t.Context(), a, "docs/a b.txt")
		if err != nil || entry == nil || entry.Path != "docs/a b.txt" || entry.Size != 19 {
			t.Fatal(entry, err)
		}
		for _, requested := range []string{"missing", "directory"} {
			if entry, err := g.FileMetadata(t.Context(), a, requested); err != nil || entry != nil {
				t.Fatal(requested, entry, err)
			}
		}
		if _, err := g.FileMetadata(t.Context(), a, "denied"); err == nil {
			t.Fatal("permission failure hidden")
		}
		if _, err := g.FileMetadata(t.Context(), a, "../escape"); err == nil {
			t.Fatal("unsafe path accepted")
		}
	})
}
