package server

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

type documentConnectionProbe struct {
	*fixtureProvider
	choices []string
}

func (p *documentConnectionProbe) ConnectDocument(ctx context.Context, q provider.DocumentRequest, choice string) (provider.Access, error) {
	p.choices = append(p.choices, choice)
	return p.fixtureProvider.ConnectDocument(ctx, q, choice)
}

func TestEmbeddedSourceConnectionQuery(t *testing.T) {
	for _, kind := range []string{"gist", "pr"} {
		for _, raw := range []string{"connection=oauth&connection=github-app", "connection[]=oauth", "connection[kind]=oauth"} {
			t.Run(kind+"/"+raw, func(t *testing.T) {
				// No provider or database is needed to reject an ambiguous credential choice.
				s := &Server{}
				q := &request{Server: s, R: httptest.NewRequest("GET", "/?"+raw, nil), Params: map[string]string{"owner": "team", "repository": "project", "id": "1"}, User: M{"_id": "owner"}}
				_, err := s.embeddedSource(kind)(q)
				if err == nil || err.Error() != "invalid_connection" {
					t.Fatalf("ambiguous connection accepted: %v", err)
				}
			})
		}
		for _, raw := range []string{"", "connection=custom-grant"} {
			t.Run(kind+"/fixture/"+raw, func(t *testing.T) {
				p := &documentConnectionProbe{fixtureProvider: &fixtureProvider{name: "team/project", commit: "opaque"}}
				registry, err := provider.New(p)
				if err != nil {
					t.Fatal(err)
				}
				s := &Server{providers: registry}
				q := &request{Server: s, R: httptest.NewRequest("GET", "/?name=team/project&"+raw, nil), Params: map[string]string{"provider": "fixture", "id": "1"}, User: M{"_id": "owner"}}
				_, err = s.embeddedSource(kind)(q)
				expected := ""
				if raw != "" {
					expected = "custom-grant"
				}
				if err != nil || len(p.choices) != 1 || p.choices[0] != expected {
					t.Fatalf("provider choice lost: %v %v", p.choices, err)
				}
			})
		}
	}
}
