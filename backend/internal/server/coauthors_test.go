package server

import (
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"testing"
)

func TestCoauthorSelfIdentity(t *testing.T) {
	user := security.Identity{ID: "user", Username: "alice", GitHubID: "123", Status: "active"}
	for _, c := range []struct {
		name, target string
		list         []any
		want         bool
	}{
		{"stable identity survives rename", "former-name", []any{M{"username": "former-name", "githubId": "123"}}, true},
		{"reused username cannot override identity", "alice", []any{M{"username": "alice", "githubId": "other"}}, false},
		{"legacy username", "ALICE", []any{M{"username": "Alice"}}, true},
		{"absent self", "ALICE", nil, true},
		{"absent stranger", "bob", nil, false},
		{"first matching identity wins", "alice", []any{M{"username": "alice", "githubId": "other"}, M{"username": "ALICE", "githubId": "123"}}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := coauthorSelf(user, c.list, c.target); got != c.want {
				t.Fatalf("got %v want %v", got, c.want)
			}
		})
	}
	user.Status = "banned"
	if coauthorSelf(user, nil, "alice") {
		t.Fatal("inactive identity accepted")
	}
}
