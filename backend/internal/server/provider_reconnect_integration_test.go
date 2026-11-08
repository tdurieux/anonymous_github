package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type reconnectProbe struct {
	*fixtureProvider
	branchError    error
	calls, commits int
}

func (p *reconnectProbe) Connect(ctx context.Context, q provider.ConnectRequest) (provider.Connection, error) {
	p.calls++
	return p.fixtureProvider.Connect(ctx, q)
}
func (p *reconnectProbe) Commit(ctx context.Context, a provider.Access, ref string) (provider.Commit, error) {
	p.commits++
	return p.fixtureProvider.Commit(ctx, a, ref)
}
func (p *reconnectProbe) Branch(context.Context, provider.Access, string) (provider.Commit, error) {
	return provider.Commit{ID: p.commit}, p.branchError
}

func runProviderReconnectIntegration(t *testing.T, base *Server) {
	t.Run("provider reconnect validates before upstream access and preserves failures", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		db := base.Store.DB.Client().Database("provider_reconnect_" + owner.Hex())
		defer db.Drop(ctx)
		p := &reconnectProbe{fixtureProvider: &fixtureProvider{name: "team/subgroup/project", commit: "revision:one"}}
		registry, err := provider.New(p)
		if err != nil {
			t.Fatal(err)
		}
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}, providers: registry}
		user := M{"_id": owner, "status": "active", "username": "owner"}
		previous := M{"_id": bson.NewObjectID(), "repoId": "reconnect-probe", "owner": owner, "status": "ready", "source": M{"provider": "fixture", "repositoryName": p.name, "providerRepositoryId": "old:identity", "branch": "main", "commit": p.commit}, "providerAccess": M{"kind": "fixture-grant"}, "options": M{}}
		if _, err := db.Collection(collection("repo")).InsertOne(ctx, previous); err != nil {
			t.Fatal(err)
		}
		source := M{"provider": "fixture", "branch": "main", "commit": p.commit}
		q := &request{Server: s, R: httptest.NewRequest("POST", "/", nil), Params: map[string]string{"id": "reconnect-probe"}, User: user, Identity: identity(user), Body: M{"repoId": "reconnect-probe", "fullName": p.name, "source": source, "options": M{}, "terms": []any{}, "reconnectRepositoryId": nil}}
		// Exercise the real save handler: null must not take its settings-only shortcut.
		_, err = s.saveResource("repo", false)(q)
		if err == nil || err.Error() != "repo_not_found" || p.calls != 0 {
			t.Fatal("null bypassed preflight", p.calls, err)
		}
		for _, c := range []struct {
			value                     any
			status, name, actor, code string
		}{
			{"", "ready", p.name, owner.Hex(), "repo_not_found"},
			{"fixture_project:123", "ready", "different/project", owner.Hex(), "repo_not_found"},
			{"fixture_project:123", "queue", p.name, owner.Hex(), "invalid_status"},
			{"fixture_project:123", "ready", p.name, "another-owner", "not_owner"},
		} {
			q.Body["reconnectRepositoryId"], q.Body["fullName"], q.Identity.ID = c.value, c.name, c.actor
			previous["status"] = c.status
			_, _, err := s.saveRepositorySource(q, previous, source)
			if err == nil || err.Error() != c.code || p.calls != 0 {
				t.Fatal("provider called before validation", c, p.calls, err)
			}
		}
		previous["status"] = "ready"
		q.Identity.ID = owner.Hex()
		q.Body["fullName"], q.Body["reconnectRepositoryId"] = p.name, "fixture_project:123"
		for _, c := range []struct {
			err    error
			code   string
			status int
		}{
			{provider.ErrBranchNotFound, "branch_not_specified", 400},
			{provider.ErrAccessDenied, "not_authorized", 403},
			{&provider.RateLimitError{ResetAt: time.UnixMilli(1800000000123)}, "rate_limited", 429},
			{provider.ErrUpstream, "upstream_error", 502},
		} {
			p.branchError = fmt.Errorf("private provider details: %w", c.err)
			_, _, err := s.saveRepositorySource(q, previous, source)
			w := httptest.NewRecorder()
			writeError(w, err)
			var result M
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if w.Code != c.status || result["error"] != c.code || strings.Contains(w.Body.String(), "private") || p.commits != 0 {
				t.Fatal("branch failure lost", w.Code, w.Body, p.commits)
			}
			if c.code == "rate_limited" && number(result["resetAt"]) != 1800000000123 {
				t.Fatal("retry time lost", result)
			}
		}
		q.Body["reconnectRepositoryId"] = "fixture_another:identity"
		_, _, err = s.saveRepositorySource(q, previous, source)
		if err == nil || err.Error() != "connection_changed" || p.commits != 0 {
			t.Fatal("preview mismatch not checked first", err)
		}
		if count, err := db.Collection("repositories").CountDocuments(ctx, M{}); err != nil || count != 0 {
			t.Fatal("failed reconnect cached metadata", count, err)
		}
		p.branchError = nil
		q.Body["reconnectRepositoryId"] = "fixture_project:123"
		saved, binding, err := s.saveRepositorySource(q, previous, source)
		if err != nil || saved["providerRepositoryId"] != "project:123" || saved["commit"] != p.commit || binding["kind"] != "fixture-grant" || p.commits != 1 {
			t.Fatal("valid opaque reconnect failed", saved, binding, p.commits, err)
		}
	})
}
