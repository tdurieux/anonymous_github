package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type selectedPreviewProbe struct {
	*previewProbe
	selections int
	force      bool
}

func (p *selectedPreviewProbe) PreviewSelectedReadme(ctx context.Context, a provider.Access, match provider.BranchMatch, force bool) (string, error) {
	p.selections++
	p.force = force
	p.discovered = a
	ok, err := match("team/release")
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fail("readme_not_available", 404)
	}
	return "selected provider README", nil
}

func runProviderHintIntegration(t *testing.T, base *Server) {
	t.Run("provider cache hints preserve authorization and opaque identity", func(t *testing.T) {
		ctx := context.Background()
		owner, key := bson.NewObjectID(), bson.NewObjectID()
		db := base.Store.DB.Client().Database("provider_hint_" + owner.Hex())
		defer db.Drop(ctx)
		p := &previewProbe{fixtureProvider: &fixtureProvider{name: "new/team/project", commit: "opaque:commit"}, currentID: "project:123"}
		registry, err := provider.New(p)
		if err != nil {
			t.Fatal(err)
		}
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}, providers: registry}
		user := M{"_id": owner, "username": "owner", "status": "active"}
		_, err = db.Collection("repositories").InsertOne(ctx, M{"_id": key, "source": "fixture", "externalId": "fixture_project:123", "name": "cached/team/project"})
		if err != nil {
			t.Fatal(err)
		}
		call := func(mode string, query url.Values) (any, error) {
			q := &request{Server: s, R: httptest.NewRequest("GET", "/?"+query.Encode(), nil), W: httptest.NewRecorder(), Params: map[string]string{"provider": "fixture"}, User: user, Identity: identity(user)}
			return s.sourceRepository(mode)(q)
		}
		query := url.Values{"name": {"old/team/project"}, "repositoryID": {key.Hex()}}
		for _, mode := range []string{"metadata", "branches", "readme"} {
			result, err := call(mode, query)
			if err != nil || p.connected.RepositoryID != "project:123" || p.connected.OwnerID != owner.Hex() || p.authorized.Ref.ID != "project:123" {
				t.Fatal("cache did not pin authorized identity", mode, result, p.connected, err)
			}
			if mode != "metadata" && p.discovered.Ref.Name != p.name {
				t.Fatal("stale discovery name", p.discovered)
			}
		}
		for _, hint := range []url.Values{
			{"name": {"old/team/project"}, "repositoryID[]": {key.Hex()}},
			{"name": {"old/team/project"}, "repositoryID": {key.Hex(), key.Hex()}},
			{"name": {"old/team/project"}, "repositoryID[_id]": {key.Hex()}},
		} {
			if _, err := call("metadata", hint); err != nil || p.connected.RepositoryID != "project:123" {
				t.Fatal("extended cache ID", hint, err)
			}
		}

		if _, err := call("readme", url.Values{"name": {"old/team/project"}, "branch[]": {"team/release"}}); err != nil || p.readmeBranch != "team/release" {
			t.Fatal("opaque provider branch query", p.readmeBranch, err)
		}
		selected := &selectedPreviewProbe{previewProbe: p}
		selectedRegistry, err := provider.New(selected)
		if err != nil {
			t.Fatal(err)
		}
		s.providers = selectedRegistry
		if _, err := call("readme", url.Values{"name": {"old/team/project"}, "branch[]": {"team/release"}, "force": {"1"}}); err != nil || selected.selections != 1 || !selected.force || selected.discovered.Ref.ID != "project:123" {
			t.Fatal("provider branch selection", err, selected)
		}
		p.revoked = true
		if _, err := call("readme", url.Values{"name": {"old/team/project"}, "branch[toString]": {"x"}}); err == nil || err.Error() != "fixture_access_revoked" || selected.selections != 1 {
			t.Fatal("selection bypassed access denial", err, selected.selections)
		}
		p.revoked = false
		s.providers = registry
		before := p.repositories
		p.revoked = true
		_, err = call("metadata", query)
		if err == nil || err.Error() != "fixture_access_revoked" || p.repositories != before {
			t.Fatal("cached metadata bypassed revocation", err)
		}
		p.revoked = false
		p.currentID = "replacement:456"
		_, err = call("metadata", query)
		if err == nil || err.Error() != "connection_changed" || p.repositories != before {
			t.Fatal("adapter replaced pinned identity", err)
		}
		query.Set("reconnect", "1")
		result, err := call("metadata", query)
		if err != nil || p.connected.RepositoryID != "" || p.connected.Name != "old/team/project" || obj(result)["externalId"] != "fixture_replacement:456" {
			t.Fatal("reconnect retained old cache pin", result, p.connected, err)
		}
		query.Del("reconnect")
		p.currentID = "project:123"
		for _, bad := range []url.Values{
			{"name": {"old/team/project"}, "repositoryID": {"invalid"}},
			{"name": {"old/team/project"}, "repositoryID[]": {"invalid"}},
			{"name": {"old/team/project"}, "repositoryID": {"invalid"}, "reconnect[]": {"1"}},
			{"name": {"old/team/project"}, "repositoryID[$exists]": {"true"}},
		} {
			before := p.connects
			if _, err := call("metadata", bad); err == nil || p.connects != before {
				t.Fatal("malformed cache hint reached provider", err)
			}
		}
		foreign := bson.NewObjectID()
		if _, err := db.Collection("repositories").InsertOne(ctx, M{"_id": foreign, "source": "github", "externalId": "gh_42", "name": "other/project"}); err != nil {
			t.Fatal(err)
		}
		query.Set("repositoryID", foreign.Hex())
		before = p.connects
		if _, err := call("metadata", query); err == nil || err.Error() != "provider_binding_mismatch" || p.connects != before {
			t.Fatal("foreign provider cache accepted", err)
		}
		query.Set("repositoryID", bson.NewObjectID().Hex())
		if _, err := call("metadata", query); err != nil || p.connected.RepositoryID != "" || p.connected.Name != "old/team/project" {
			t.Fatal("missing hint failed to fall back", err)
		}
		// An explicitly saved identity cannot be replaced by another cache record.
		if _, err := db.Collection(collection("repo")).InsertOne(ctx, M{"repoId": "saved-hint", "owner": owner, "source": M{"provider": "fixture", "repositoryName": "old/team/project", "providerRepositoryId": "different:identity"}, "providerAccess": M{"kind": "fixture-grant"}}); err != nil {
			t.Fatal(err)
		}
		query.Set("repositoryID", key.Hex())
		query.Set("anonymizedRepoId", "saved-hint")
		before = p.connects
		if _, err := call("metadata", query); err == nil || err.Error() != "connection_changed" || p.connects != before {
			t.Fatal("hint replaced saved identity", err)
		}
		if _, err := s.Store.update(ctx, collection("repo"), M{"repoId": "saved-hint"}, M{"$unset": M{"source.providerRepositoryId": ""}}); err != nil {
			t.Fatal(err)
		}
		if _, err := call("metadata", query); err == nil || err.Error() != "connection_changed" || p.connects != before {
			t.Fatal("hint redirected an unpinned saved source", err)
		}
		if _, err := s.Store.update(ctx, collection("repo"), M{"repoId": "saved-hint"}, M{"$set": M{"source.repositoryName": p.name}}); err != nil {
			t.Fatal(err)
		}
		query.Set("name", p.name)
		if _, err := call("metadata", query); err == nil || err.Error() != "connection_changed" || p.connects != before {
			t.Fatal("matching name established an unverified saved identity", err)
		}

	})
	t.Run("GitHub legacy cache hints resolve renames by upstream ID", func(t *testing.T) {
		ctx := context.Background()
		owner, key := bson.NewObjectID(), bson.NewObjectID()
		db := base.Store.DB.Client().Database("github_hint_" + owner.Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		s.Config.AppEnabled = false
		registry, err := provider.New(&githubProvider{s})
		if err != nil {
			t.Fatal(err)
		}
		s.providers = registry
		user := M{"_id": owner, "username": "owner", "status": "active"}
		if _, err := db.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Collection("repositories").InsertOne(ctx, M{"_id": key, "externalId": "gh_42", "name": "cached/project"}); err != nil {
			t.Fatal(err)
		}
		q := &request{Server: s, R: httptest.NewRequest("GET", "/", nil), User: user, Identity: identity(user)}
		if err := s.saveGrant(q, owner, "github", M{"access_token": "synthetic-oauth"}); err != nil {
			t.Fatal(err)
		}
		counts := map[string]int{}
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			if r.Header.Get("Authorization") != "Bearer synthetic-oauth" {
				t.Fatal("wrong preview credential")
			}
			counts[r.URL.Path]++
			var data any
			switch r.URL.Path {
			case "/repositories/42":
				data = M{"id": 42, "full_name": "renamed/project", "default_branch": "main", "size": 1}
			case "/repos/renamed/project/branches":
				data = []M{{"name": "main", "commit": M{"sha": strings.Repeat("a", 40)}}}
			case "/repos/renamed/project/readme":
				data = M{"encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte("renamed README"))}
			default:
				t.Fatal("stale name or foreign identity requested", r.URL)
			}
			b, _ := json.Marshal(data)
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(b)))}, nil
		})}
		for _, mode := range []string{"metadata", "branches", "readme"} {
			q.R = httptest.NewRequest("GET", "/?force=1&repositoryID="+key.Hex(), nil)
			q.W = httptest.NewRecorder()
			q.Params = map[string]string{"owner": "old", "repo": "project"}
			result, err := s.sourceRepository(mode)(q)
			if err != nil {
				t.Fatal(mode, err)
			}
			if mode == "metadata" && (obj(result)["externalId"] != "gh_42" || obj(result)["fullName"] != "renamed/project") {
				t.Fatal("wrong renamed preview", result)
			}
		}
		if counts["/repositories/42"] != 3 || counts["/repos/renamed/project/branches"] != 2 || counts["/repos/renamed/project/readme"] != 1 {
			t.Fatal("wrong preview lookups", counts)
		}
		s.Config.AppEnabled = true
		if err := s.saveGrant(q, owner, "github-app-user", M{"access_token": "synthetic-app", "refresh_token": "synthetic-refresh", "expires_in": float64(3600), "refresh_token_expires_in": float64(7200)}); err != nil {
			t.Fatal(err)
		}
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			if r.Header.Get("Authorization") != "Bearer synthetic-app" {
				t.Fatal("wrong App credential")
			}
			data := M{}
			switch r.URL.Path {
			case "/user/installations":
				data["installations"] = []M{}
			case "/repositories/42", "/repos/renamed/project":
				data = M{"id": 42, "full_name": "renamed/project", "private": false, "visibility": "public"}
			default:
				t.Fatal("App connection used stale name", r.URL)
			}
			b, _ := json.Marshal(data)
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(b)))}, nil
		})}
		connection, err := (&githubProvider{s}).Connect(ctx, provider.ConnectRequest{OwnerID: owner.Hex(), Name: "cached/project", Connection: "github-app", RepositoryID: "42"})
		if err != nil || connection.Ref.ID != "42" || connection.Ref.Name != "renamed/project" || number(connection.Binding["repositoryId"]) != 42 {
			t.Fatal("App connection lost resolved identity", connection, err)
		}

	})
}
