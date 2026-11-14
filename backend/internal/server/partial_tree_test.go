package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// Keep this optional capability off fixtureProvider: wrappers that override
// Tree must continue exercising their own retry, rate-limit and blocking paths.
type partialTreeFixture struct {
	*fixtureProvider
	onPartialTree func(context.Context, provider.Access) ([]provider.Entry, []string, error)
}

func (p *partialTreeFixture) TreeWithTruncation(ctx context.Context, a provider.Access) ([]provider.Entry, []string, error) {
	return p.onPartialTree(ctx, a)
}

func runPartialTreeIntegration(t *testing.T, s *Server, p *fixtureProvider) {
	t.Run("partial provider tree import beyond old limit", func(t *testing.T) {
		ctx := t.Context()
		original, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil || original == nil {
			t.Fatal(err)
		}
		repo := selectFields(original, "owner", "source", "providerAccess")
		id := "partial-" + bson.NewObjectID().Hex()
		repo["_id"], repo["repoId"], repo["status"] = bson.NewObjectID(), id, "preparing"
		repo["options"] = M{"terms": []string{"docs => redacted"}}
		if _, err = s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
			t.Fatal(err)
		}
		defer s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": id})
		defer s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": id})
		originalRegistry := s.providers
		defer func() { s.providers = originalRegistry }()
		partial := &partialTreeFixture{fixtureProvider: p}
		s.providers, err = provider.New(partial)
		if err != nil {
			t.Fatal(err)
		}
		partial.onPartialTree = func(context.Context, provider.Access) ([]provider.Entry, []string, error) {
			return nil, []string{"../escape"}, nil
		}
		if err = s.prepareTree(ctx, repo); err == nil || err.Error() != "invalid_file_path" {
			t.Fatal(err)
		}
		partial.onPartialTree = func(context.Context, provider.Access) ([]provider.Entry, []string, error) {
			rows := make([]provider.Entry, 100001)
			for i := range rows {
				rows[i] = provider.Entry{Path: fmt.Sprintf("docs/file-%06d", i), Revision: "opaque:entry", Size: 1}
			}
			return rows, []string{"docs"}, nil
		}
		if err = s.prepareTree(ctx, repo); err != nil {
			t.Fatal(err)
		}
		current, err := s.Store.one(ctx, collection("repo"), M{"repoId": id})
		if err != nil || str(current["status"]) != "ready" || !reflect.DeepEqual(stringsOf(current["truncatedFolders"]), []string{"docs"}) {
			t.Fatal(current, err)
		}
		if count, err := s.Store.DB.Collection("files").CountDocuments(ctx, M{"repoId": id, "treeGeneration": current["treeGeneration"]}); err != nil || count != 100001 {
			t.Fatal(count, err)
		}
		request := httptest.NewRequest("GET", "/api/repo/"+id+"/options", nil)
		request.RemoteAddr = "198.51.100.66:1234"
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		var body M
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != 200 || !reflect.DeepEqual(stringsOf(body["truncatedFolders"]), []string{"redacted"}) {
			t.Fatal(response.Code, body)
		}

	})
}

func runGitHubPartialTreeIntegration(t *testing.T, s *Server, owner any) {
	t.Run("GitHub incomplete directory tree", func(t *testing.T) {
		old := s.HTTP
		defer func() { s.HTTP = old }()
		commit, child := strings.Repeat("a", 40), strings.Repeat("b", 40)
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			var payload M
			switch r.URL.Path {
			case "/repos/owner/repo/git/trees/" + commit:
				if r.URL.Query().Get("recursive") == "1" {
					payload = M{"truncated": true, "tree": []M{}}
				} else {
					payload = M{"truncated": true, "tree": []M{{"path": "docs", "sha": child, "type": "tree"}, {"path": "root.txt", "sha": commit, "type": "blob", "size": 1}, {"path": "submodule", "sha": commit, "type": "commit"}}}
				}
			case "/repos/owner/repo/contents/submodule":
				payload = M{"sha": commit, "submodule_git_url": "https://example.test/owner/private"}
			case "/repos/owner/repo/git/trees/" + child:
				payload = M{"truncated": true, "tree": []M{{"path": "visible.txt", "sha": commit, "type": "blob", "size": 2}}}
			default:
				t.Fatal("unexpected tree path", r.URL.Path)
			}
			raw, _ := json.Marshal(payload)
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
		})}
		g := &githubProvider{s}
		a := provider.Access{OwnerID: str(owner), Ref: provider.Ref{Provider: "github", Name: "owner/repo", Commit: commit}, Binding: map[string]any{"kind": "oauth"}}
		entries, folders, err := g.TreeWithTruncation(t.Context(), a)
		if err != nil || !reflect.DeepEqual(folders, []string{"", "docs"}) || len(entries) != 4 || entries[3].Path != "docs/visible.txt" || entries[2].Path != "submodule" || !entries[2].Directory {
			t.Fatal(entries, folders, err)
		}
	})
}
