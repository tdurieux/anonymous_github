package server

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

type discoveryFixture struct{ request provider.ListRequest }

func (p *discoveryFixture) ID() string { return "other-forge" }
func (p *discoveryFixture) List(_ context.Context, r provider.ListRequest) ([]provider.Repository, error) {
	p.request = r
	return []provider.Repository{{ID: "opaque:123", Name: "team/subgroup/project"}}, nil
}
func (p *discoveryFixture) Branches(context.Context, provider.Access) ([]provider.Branch, error) {
	return nil, nil
}
func (p *discoveryFixture) Readme(context.Context, provider.Access, string) (string, error) {
	return "", nil
}

func TestProviderDiscoveryRefresh(t *testing.T) {
	for _, c := range []struct {
		query string
		force bool
	}{{"", false}, {"?force=1", true}, {"?force=true", false}, {"?force=0", false}, {"?force=1&force=1", false}} {
		p := &discoveryFixture{}
		registry, err := provider.New(p)
		if err != nil {
			t.Fatal(err)
		}
		s := &Server{providers: registry}
		q := &request{R: httptest.NewRequest("GET", "/"+c.query, nil), User: M{"_id": "owner"}, Params: map[string]string{"provider": p.ID()}}
		result, err := s.allRepositories(q)
		if err != nil {
			t.Fatal(err)
		}
		if p.request.OwnerID != "owner" || p.request.Force != c.force {
			t.Fatalf("%s: %+v", c.query, p.request)
		}
		rows := result.([]M)
		if len(rows) != 1 || rows[0]["fullName"] != "team/subgroup/project" || rows[0]["id"] != externalRepositoryID(p.ID(), "opaque:123") {
			t.Fatal(rows)
		}
	}
}
