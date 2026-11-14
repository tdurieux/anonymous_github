package server

import (
	"context"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type previewProbe struct {
	*fixtureProvider
	currentID                              string
	readmeBranch                           string
	connects, authorizations, repositories int
	connected                              provider.ConnectRequest
	authorized, discovered                 provider.Access
}

func (p *previewProbe) Connect(ctx context.Context, q provider.ConnectRequest) (provider.Connection, error) {
	p.connects++
	p.connected = q
	c, err := p.fixtureProvider.Connect(ctx, q)
	c.Ref.ID = p.currentID
	return c, err
}
func (p *previewProbe) Authorize(ctx context.Context, a provider.Access) error {
	p.authorizations++
	p.authorized = a
	return p.fixtureProvider.Authorize(ctx, a)
}
func (p *previewProbe) Repository(ctx context.Context, a provider.Access) (provider.Repository, error) {
	p.repositories++
	r, e := p.fixtureProvider.Repository(ctx, a)
	r.ID = p.currentID
	return r, e
}
func (p *previewProbe) List(context.Context, provider.ListRequest) ([]provider.Repository, error) {
	return nil, nil
}
func (p *previewProbe) Branches(_ context.Context, a provider.Access) ([]provider.Branch, error) {
	p.discovered = a
	return []provider.Branch{{Name: "main", Commit: p.commit}}, nil
}
func (p *previewProbe) Readme(_ context.Context, a provider.Access, branch string) (string, error) {
	p.discovered = a
	p.readmeBranch = branch
	return "provider README", nil
}

func runProviderPreviewIntegration(t *testing.T, base *Server) {
	t.Run("saved source previews authorize before using owner bindings", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		db := base.Store.DB.Client().Database("provider_preview_" + owner.Hex())
		defer db.Drop(ctx)
		p := &previewProbe{fixtureProvider: &fixtureProvider{name: "team/subgroup/renamed", commit: "opaque:commit"}, currentID: "project:123"}
		registry, err := provider.New(p)
		if err != nil {
			t.Fatal(err)
		}
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}, providers: registry}
		savedName := "team/subgroup/project"
		record := M{"_id": bson.NewObjectID(), "repoId": "preview-probe", "owner": owner, "status": "ready", "source": M{"provider": "fixture", "repositoryName": savedName, "providerRepositoryId": "project:123", "branch": "main"}, "providerAccess": M{"provider": "fixture", "kind": "fixture-grant", "revision": "saved:binding"}, "coauthors": []M{{"username": "collaborator"}}}
		if _, err := db.Collection(collection("repo")).InsertOne(ctx, record); err != nil {
			t.Fatal(err)
		}
		users := map[string]M{
			"owner":        {"_id": owner, "username": "owner", "status": "active"},
			"collaborator": {"_id": bson.NewObjectID(), "username": "collaborator", "status": "active"},
			"stranger":     {"_id": bson.NewObjectID(), "username": "stranger", "status": "active"},
		}
		call := func(actor, mode, name, id, reconnect string) (any, error) {
			query := url.Values{"name": {name}, "anonymizedRepoId": {id}, "connection": {"untrusted-choice"}}
			if reconnect != "" {
				query.Set("reconnect", reconnect)
			}
			user := users[actor]
			q := &request{Server: s, R: httptest.NewRequest("GET", "/?"+query.Encode(), nil), W: httptest.NewRecorder(), Params: map[string]string{"provider": "fixture"}, User: user, Identity: identity(user)}
			return s.sourceRepository(mode)(q)
		}
		for _, mode := range []string{"metadata", "branches", "readme"} {
			result, err := call("collaborator", mode, savedName, "preview-probe", "")
			if err != nil || p.connects != 0 || p.authorized.OwnerID != owner.Hex() || p.authorized.Binding["revision"] != "saved:binding" {
				t.Fatal("saved owner access not retained", mode, result, p.authorized, err)
			}
			if mode != "metadata" && (p.discovered.Ref.Name != p.name || p.discovered.Ref.ID != "project:123") {
				t.Fatal("discovery used stale name", p.discovered)
			}
			if mode == "metadata" && obj(result)["externalId"] != "fixture_project:123" {
				t.Fatal("wrong preview identity", result)
			}
		}
		{
			user := users["collaborator"]
			q := &request{Server: s, User: user, Identity: identity(user), R: httptest.NewRequest("GET", "/?anonymizedRepoId=preview-probe&connection[]=ignored", nil)}
			access, err := s.previewRepositoryAccess(q, p, "fixture", savedName)
			if err != nil || access.OwnerID != owner.Hex() || access.Binding["revision"] != "saved:binding" || p.connects != 0 {
				t.Fatal("saved preview used untrusted query choice", access, err)
			}
		}
		beforeAuth, beforeRepo := p.authorizations, p.repositories
		for _, c := range []struct{ actor, name, id, reconnect, code string }{
			{"stranger", savedName, "preview-probe", "", "not_authorized"},
			{"owner", "different/project", "preview-probe", "", "repo_not_found"},
			{"owner", savedName, "missing", "", "repo_not_found"},
			{"collaborator", savedName, "preview-probe", "1", "not_owner"},
		} {
			_, err := call(c.actor, "metadata", c.name, c.id, c.reconnect)
			if err == nil || err.Error() != c.code || p.connects != 0 || p.authorizations != beforeAuth || p.repositories != beforeRepo {
				t.Fatal("unauthorized preview reached provider", c, err)
			}
		}
		if _, err := s.Store.update(ctx, collection("repo"), M{"_id": record["_id"]}, M{"$set": M{"status": "archived"}}); err != nil {
			t.Fatal(err)
		}
		_, err = call("owner", "metadata", savedName, "preview-probe", "1")
		if err == nil || err.Error() != "repository_archived" || p.connects != 0 {
			t.Fatal("archived reconnect reached provider", err)
		}
		if _, err := s.Store.update(ctx, collection("repo"), M{"_id": record["_id"]}, M{"$set": M{"status": "ready"}}); err != nil {
			t.Fatal(err)
		}
		p.revoked = true
		_, err = call("collaborator", "metadata", savedName, "preview-probe", "")
		if err == nil || err.Error() != "fixture_access_revoked" || p.repositories != beforeRepo {
			t.Fatal("revoked preview returned cached metadata", err)
		}
		p.revoked = false
		p.currentID = "project:replacement"
		_, err = call("owner", "metadata", savedName, "preview-probe", "")
		if err == nil || err.Error() != "connection_changed" || p.connects != 0 {
			t.Fatal("preview silently switched identity", err)
		}
		result, err := call("owner", "metadata", savedName, "preview-probe", "1")
		if err != nil || obj(result)["externalId"] != "fixture_project:replacement" || p.connects != 1 || p.connected.OwnerID != owner.Hex() || p.connected.Connection != "fixture-grant" || p.connected.Name != savedName {
			t.Fatal("owner reconnect did not use saved connection choice", result, p.connected, err)
		}
		// Malformed connection values cannot reach a provider adapter.
		for _, query := range []string{"connection[]=fixture-grant", "connection=fixture-grant&connection[]=other", "connection[x]=fixture-grant"} {
			user := users["stranger"]
			q := &request{Server: s, User: user, Identity: identity(user), R: httptest.NewRequest("GET", "/?"+query, nil)}
			before := p.connects
			_, err := s.previewRepositoryAccess(q, p, "fixture", savedName)
			if err == nil || err.Error() != "invalid_connection" || p.connects != before {
				t.Fatal("invalid choice reached provider", query, err)
			}
		}
		// A mixed saved-resource parameter is an array in Express. It must
		// connect as the caller rather than borrowing the saved owner's grant.
		user := users["stranger"]
		q := &request{Server: s, User: user, Identity: identity(user), R: httptest.NewRequest("GET", "/?anonymizedRepoId=preview-probe&anonymizedRepoId[]=preview-probe&connection=provider-specific-grant", nil)}
		access, err := s.previewRepositoryAccess(q, p, "fixture", savedName)
		if err != nil || access.OwnerID != str(user["_id"]) || p.connected.OwnerID != str(user["_id"]) || p.connected.Connection != "provider-specific-grant" {
			t.Fatal("mixed resource selected owner credentials", access, err)
		}
		current, err := s.Store.one(ctx, collection("repo"), M{"_id": record["_id"]})
		if err != nil || obj(current["source"])["providerRepositoryId"] != "project:123" || obj(current["providerAccess"])["revision"] != "saved:binding" {
			t.Fatal("preview changed saved resource", current, err)
		}
	})
}
