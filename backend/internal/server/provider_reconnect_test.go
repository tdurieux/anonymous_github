package server

import (
	"errors"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
)

func TestRepositoryReconnectPreflight(t *testing.T) {
	for _, c := range []struct {
		name, provider, owner, status string
		value                         any
		code                          string
		httpStatus                    int
	}{
		{"null", "github", "owner", "ready", nil, "repo_not_found", 400},
		{"empty", "github", "owner", "ready", "", "repo_not_found", 400},
		{"numeric", "github", "owner", "ready", 42, "repo_not_found", 400},
		{"object", "github", "owner", "ready", M{"id": "gh_42"}, "repo_not_found", 400},
		{"zero", "github", "owner", "ready", "gh_0", "repo_not_found", 400},
		{"negative", "github", "owner", "ready", "gh_-1", "repo_not_found", 400},
		{"leading-zero", "github", "owner", "ready", "gh_042", "repo_not_found", 400},
		{"foreign", "fixture", "owner", "ready", "gh_42", "repo_not_found", 400},
		{"owner-first", "github", "other", "ready", nil, "not_owner", 403},
		{"active", "github", "owner", "download", "gh_42", "invalid_status", 409},
		{"archived", "github", "owner", "archived", "gh_42", "repository_archived", 410},
		{"github", "github", "owner", "ready", "gh_42", "", 0},
		{"opaque", "fixture", "owner", "ready", "fixture_project:123", "", 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			q := &request{Body: M{"fullName": "team/project", "reconnectRepositoryId": c.value}, Identity: security.Identity{ID: c.owner}}
			previous := M{"owner": "owner", "status": c.status, "source": M{"repositoryName": "team/project"}}
			present, id, err := validateRepositoryReconnect(q, previous, c.provider)
			if !present {
				t.Fatal("reconnect ignored")
			}
			if c.code == "" {
				if err != nil || id != c.value {
					t.Fatal(id, err)
				}
				return
			}
			var api *APIError
			if !errors.As(err, &api) || api.Code != c.code || api.Status != c.httpStatus {
				t.Fatal(err)
			}
		})
	}
	q := &request{Body: M{}, Identity: security.Identity{ID: "owner"}}
	if present, _, err := validateRepositoryReconnect(q, M{}, "github"); present || err != nil {
		t.Fatal("ordinary save treated as reconnect", err)
	}
}
