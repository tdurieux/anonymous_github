package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

type identityProbe struct {
	*fixtureProvider
	connection func(*provider.Connection)
	repository func(*provider.Repository)
}

func (p *identityProbe) Connect(ctx context.Context, q provider.ConnectRequest) (provider.Connection, error) {
	c, e := p.fixtureProvider.Connect(ctx, q)
	if e == nil && p.connection != nil {
		p.connection(&c)
	}
	return c, e
}
func (p *identityProbe) Repository(ctx context.Context, a provider.Access) (provider.Repository, error) {
	r, e := p.fixtureProvider.Repository(ctx, a)
	if e == nil && p.repository != nil {
		p.repository(&r)
	}
	return r, e
}
func (p *identityProbe) ConnectDocument(ctx context.Context, q provider.DocumentRequest, choice string) (provider.Access, error) {
	a, e := p.fixtureProvider.ConnectDocument(ctx, q, choice)
	if e == nil && p.connection != nil {
		c := provider.Connection{Ref: a.Ref, Binding: a.Binding}
		p.connection(&c)
		a.Ref, a.Binding = c.Ref, c.Binding
	}
	return a, e
}

func runProviderIdentityIntegration(t *testing.T, s *Server, p *fixtureProvider, token string) {
	t.Run("provider identity checks before persistence", func(t *testing.T) {
		original := s.providers
		defer func() { s.providers = original }()
		ctx := context.Background()
		counts := map[string]int64{}
		for _, coll := range []string{"repositories", collection("repo"), collection("gist")} {
			n, err := s.Store.DB.Collection(coll).CountDocuments(ctx, M{})
			if err != nil {
				t.Fatal(err)
			}
			counts[coll] = n
		}
		for _, c := range []struct {
			name, code string
			status     int
			connection func(*provider.Connection)
			repository func(*provider.Repository)
		}{
			{name: "foreign-provider", code: "provider_binding_mismatch", status: 409, connection: func(c *provider.Connection) { c.Ref.Provider = "github" }},
			{name: "foreign-binding", code: "provider_binding_mismatch", status: 409, connection: func(c *provider.Connection) { c.Binding["provider"] = "github" }},
			{name: "wrong-repository", code: "connection_changed", status: 409, repository: func(r *provider.Repository) { r.ID = "another-project" }},
			{name: "missing-id", code: "provider_invalid_response", status: 502, repository: func(r *provider.Repository) { r.ID = "" }},
			{name: "missing-name", code: "provider_invalid_response", status: 502, repository: func(r *provider.Repository) { r.Name = "" }},
		} {
			providers := original.All()
			for i, entry := range providers {
				if entry.ID() == "fixture" {
					providers[i] = &identityProbe{fixtureProvider: p, connection: c.connection, repository: c.repository}
				}
			}
			registry, err := provider.New(providers...)
			if err != nil {
				t.Fatal(err)
			}
			s.providers = registry
			requests := []struct {
				method, path string
				body         any
			}{
				{"GET", "/api/providers/fixture/repository/metadata?name=" + url.QueryEscape(p.name), nil},
				{"POST", "/api/repo", M{"repoId": "identity-" + c.name, "fullName": p.name, "source": M{"provider": "fixture", "branch": "main", "commit": p.commit}, "terms": []any{}, "options": M{}}},
			}
			if c.connection != nil {
				requests = append(requests, struct {
					method, path string
					body         any
				}{"POST", "/api/gist", M{"gistId": "identity-" + c.name, "source": M{"provider": "fixture", "gistId": "snippet"}, "terms": []any{}, "options": M{}}})
			}
			for _, request := range requests {
				raw, _ := json.Marshal(request.body)
				req := httptest.NewRequest(request.method, request.path, bytes.NewReader(raw))
				req.RemoteAddr = "198.51.100.7:1234"
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", "Bearer "+token)
				w := httptest.NewRecorder()
				s.ServeHTTP(w, req)
				var body M
				if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if w.Code != c.status || body["error"] != c.code {
					t.Fatalf("%s %s: %d %s", c.name, request.path, w.Code, w.Body)
				}
			}
		}
		for coll, before := range counts {
			after, err := s.Store.DB.Collection(coll).CountDocuments(ctx, M{})
			if err != nil || after != before {
				t.Fatal("invalid identity persisted", coll, before, after, err)
			}
		}
	})
}
