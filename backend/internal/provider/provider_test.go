package provider

import (
	"errors"
	"testing"
)

type named string

func (n named) ID() string { return string(n) }
func TestRegistry(t *testing.T) {
	for _, entries := range [][]Provider{{nil}, {named("GitHub")}, {named("../host")}, {named("github"), named("github")}} {
		if _, e := New(entries...); e == nil {
			t.Fatalf("accepted %#v", entries)
		}
	}
	r, e := New(named("fixture"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = r.Get("github"); !errors.Is(e, ErrUnknown) {
		t.Fatal(e)
	}
	if _, e = r.Repositories("fixture"); !errors.Is(e, ErrCapability) {
		t.Fatal(e)
	}
	if p, e := r.Get("fixture"); e != nil || p.ID() != "fixture" {
		t.Fatal(p, e)
	}
}

type changingProvider struct {
	calls        int
	first, later string
}

func (p *changingProvider) ID() string {
	p.calls++
	if p.calls == 1 {
		return p.first
	}
	return p.later
}

type mapProvider map[string]string

func (p mapProvider) ID() string { return "map-provider" }

func TestRegistryCapturesIdentityOnce(t *testing.T) {
	p := &changingProvider{first: "fixture", later: "github"}
	builtin := named("github")
	r, err := New(builtin, p)
	if err != nil {
		t.Fatal(err)
	}
	if p.calls != 1 {
		t.Fatal("provider identity read more than once", p.calls)
	}
	if actual, err := r.Get("github"); err != nil || actual != builtin {
		t.Fatal("extension replaced built-in provider", actual, err)
	}
	if actual, err := r.Get("fixture"); err != nil || actual != p {
		t.Fatal("registered identity was not retained", actual, err)
	}
	ids := r.IDs()
	if len(ids) != 2 || ids[0] != "fixture" || ids[1] != "github" {
		t.Fatal("unstable registry ordering", ids)
	}
	ids[0] = "changed"
	all := r.All()
	if len(all) != 2 || all[0] != p || all[1] != builtin || r.IDs()[0] != "fixture" || p.calls != 1 {
		t.Fatal("listing re-read mutable identities or exposed registry storage")
	}
	duplicate := &changingProvider{first: "github", later: "fixture"}
	if _, err := New(builtin, duplicate); err == nil || err.Error() != "duplicate_provider_id" {
		t.Fatal("duplicate identity accepted", err)
	}
}

func TestRegistryRejectsTypedNil(t *testing.T) {
	var pointer *changingProvider
	var mapping mapProvider
	for _, p := range []Provider{pointer, mapping} {
		if _, err := New(p); err == nil || err.Error() != "invalid_provider_id" {
			t.Fatal("typed-nil adapter accepted", err)
		}
	}
	if _, err := New(mapProvider{}); err != nil {
		t.Fatal("non-nil adapter rejected", err)
	}
}
