package server

import (
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

type mutableProviderID struct{ id string }

func (p *mutableProviderID) ID() string { return p.id }

func TestCapabilitiesUseRegisteredIdentity(t *testing.T) {
	extension := &mutableProviderID{id: "other-forge"}
	registry, err := provider.New(extension)
	if err != nil {
		t.Fatal(err)
	}
	extension.id = "github"
	s := &Server{providers: registry}
	result, err := s.providerCapabilities(nil)
	if err != nil {
		t.Fatal(err)
	}
	rows := result.([]M)
	if len(rows) != 1 || rows[0]["id"] != "other-forge" || rows[0]["repositories"] != false || rows[0]["discovery"] != false || rows[0]["documents"] != false {
		t.Fatal("capabilities advertised mutable adapter identity", rows)
	}
	if _, err := registry.Get("github"); err != provider.ErrUnknown {
		t.Fatal("extension appeared under unregistered identity", err)
	}
}
