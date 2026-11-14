package server

import (
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"testing"
)

func TestProviderConnectionIdentity(t *testing.T) {
	for _, test := range []struct {
		declared, binding string
		valid             bool
	}{
		{"", "", true}, {"fixture", "fixture", true}, {"github", "fixture", false}, {"fixture", "github", false}, {"", "github", false},
	} {
		connection := provider.Connection{Ref: provider.Ref{Provider: test.declared, ID: "immutable", Name: "team/nested/project"}, Binding: map[string]any{"provider": test.binding}}
		access, err := connectionAccess("owner", "fixture", connection)
		if (err == nil) != test.valid {
			t.Fatal(test, err)
		}
		if err == nil && (access.OwnerID != "owner" || access.Ref.Provider != "fixture" || access.Ref.ID != "immutable") {
			t.Fatal(access)
		}
	}
}
