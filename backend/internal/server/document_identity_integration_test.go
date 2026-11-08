package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

type documentIdentityProbe struct {
	*fixtureProvider
	connectedID string
	seen        []string
}

func (p *documentIdentityProbe) ConnectDocument(ctx context.Context, q provider.DocumentRequest, choice string) (provider.Access, error) {
	p.seen = append(p.seen, q.Access.Ref.ID)
	a, e := p.fixtureProvider.ConnectDocument(ctx, q, choice)
	a.Ref.ID = p.connectedID
	return a, e
}
func (p *documentIdentityProbe) Document(ctx context.Context, q provider.DocumentRequest) (map[string]any, error) {
	if q.Access.Ref.ID != "immutable:project" {
		return nil, errors.New("immutable document identity lost")
	}
	return p.fixtureProvider.Document(ctx, q)
}
func runDocumentIdentityIntegration(t *testing.T, s *Server, p *fixtureProvider, token string) {
	t.Run("document immutable provider identity", func(t *testing.T) {
		original := s.providers
		defer func() { s.providers = original }()
		probe := &documentIdentityProbe{fixtureProvider: p, connectedID: "immutable:project"}
		entries := original.All()
		for i, entry := range entries {
			if entry.ID() == "fixture" {
				entries[i] = probe
			}
		}
		registry, err := provider.New(entries...)
		if err != nil {
			t.Fatal(err)
		}
		s.providers = registry
		call := func(method, path string, body any) *httptest.ResponseRecorder {
			raw, _ := json.Marshal(body)
			req := httptest.NewRequest(method, path, bytes.NewReader(raw))
			req.RemoteAddr = "198.51.100.8:1234"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		id := "document-immutable-identity"
		body := M{"pullRequestId": id, "source": M{"provider": "fixture", "repositoryFullName": p.name, "pullRequestId": 1, "providerRepositoryId": "client-spoof"}, "terms": []any{}, "options": M{}}
		if w := call("POST", "/api/pr", body); w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		if len(probe.seen) != 1 || probe.seen[0] != "" {
			t.Fatal("client supplied immutable ID", probe.seen)
		}
		load := func() M {
			t.Helper()
			r, e := s.Store.one(context.Background(), collection("pr"), M{"pullRequestId": id})
			if e != nil {
				t.Fatal(e)
			}
			return r
		}
		r := load()
		if obj(r["source"])["providerRepositoryId"] != "immutable:project" {
			t.Fatal(r)
		}
		// Settings edits retain the saved identity despite a spoofed client source.
		obj(body["source"])["repositoryFullName"] = "renamed/by/client"
		if w := call("POST", "/api/pr/"+id, body); w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		if len(probe.seen) != 2 || probe.seen[1] != "immutable:project" {
			t.Fatal("edit lost immutable ID", probe.seen)
		}
		if w := call("POST", "/api/pr/"+id+"/refresh", nil); w.Code != 200 {
			t.Fatal("refresh lost saved ID", w.Code, w.Body)
		}
		probe.connectedID = "another:project"
		if w := call("POST", "/api/pr/"+id, body); w.Code != 409 {
			t.Fatal("adapter changed saved identity", w.Code, w.Body)
		}
		r = load()
		if obj(r["source"])["providerRepositoryId"] != "immutable:project" || r["status"] != "ready" {
			t.Fatal("rejected edit changed resource", r)
		}
	})
}
