// Package provider defines source-control operations independently of HTTP
// routes, MongoDB, anonymization, queues, and any particular hosting service.
package provider

import (
	"context"
	"errors"
	"io"
	"reflect"
	"regexp"
	"sort"
	"time"
)

type Ref struct {
	Provider, ID, Name, Branch, Commit, AnonymousID string
}

// Access contains server-owned state, never an access token or client-supplied
// endpoint. Data is opaque to the lifecycle and interpreted only by its adapter.
type Access struct {
	Ref     Ref
	OwnerID string
	Binding map[string]any
}
type ConnectRequest struct {
	OwnerID, Name, Connection string
	// RepositoryID is an optional identity from server-owned metadata. Resolve
	// and authorize that identity even when Name is stale after a rename.
	RepositoryID string
}
type Connection struct {
	Ref     Ref
	Binding map[string]any
}
type Repository struct {
	ID, Name, URL, DefaultBranch string
	Size                         int64
	HasPage                      bool
	PageBranch, PagePath         string
}
type Commit struct {
	ID   string
	Date time.Time
}
type Branch struct {
	Name, Commit string
	Readme       *string
}
type Entry struct {
	Path, Revision string
	Size           int64
	Directory      bool
}

type Provider interface{ ID() string }
type Repositories interface {
	Provider
	Connect(context.Context, ConnectRequest) (Connection, error)
	Authorize(context.Context, Access) error
	Repository(context.Context, Access) (Repository, error)
	Commit(context.Context, Access, string) (Commit, error)
	// Branch resolves a branch only, never a tag or arbitrary revision.
	Branch(context.Context, Access, string) (Commit, error)
	Tree(context.Context, Access) ([]Entry, error)
	Open(context.Context, Access, Entry) (io.ReadCloser, error)
	PublicURL(Ref) string
	// SelfLinks returns provider URLs whose repository-relative suffixes can be
	// retained when rewriting to the anonymous repository URL. Most specific first.
	SelfLinks(Ref) []string
}

// PartialTrees optionally reports incomplete directories in a tree snapshot.
// Empty string denotes the root. Adapters without this capability return
// complete trees through Repositories.Tree.
type PartialTrees interface {
	TreeWithTruncation(context.Context, Access) ([]Entry, []string, error)
}

// FileMetadata optionally recovers metadata omitted from a truncated tree.
// A nil entry means absent or not a regular file. The adapter must use the
// immutable commit in Access and must not return content or credentials.
type FileMetadata interface {
	FileMetadata(context.Context, Access, string) (*Entry, error)
}

// RepositoryPreviews optionally supports provider-specific metadata caching.
// A cache hit must still authorize access and verify the upstream identity.
// A nil cached value requires fresh metadata. Otherwise return the supplied
// snapshot after verifying access and identity; the server will not rewrite it.
type RepositoryPreviews interface {
	PreviewRepository(context.Context, Access, *Repository) (Repository, error)
}

// ListRequest keeps refresh policy independent of any hosting service.
type ListRequest struct {
	OwnerID string
	Force   bool
}

// Discovery is optional; an archive provider need not have remote search.
type Discovery interface {
	Provider
	List(context.Context, ListRequest) ([]Repository, error)
	Branches(context.Context, Access) ([]Branch, error)
	Readme(context.Context, Access, string) (string, error)
}

// DiscoveryPreviews optionally adds cache/refresh behavior after the shared
// route has authorized access and verified repository metadata.
type DiscoveryPreviews interface {
	PreviewBranches(context.Context, Access, bool) ([]Branch, error)
	PreviewReadme(context.Context, Access, string, bool) (string, error)
}

// BranchMatch is evaluated against discovered branch names. The transport
// owns name coercion; adapters own discovery and content caching.
type BranchMatch func(string) (bool, error)

// SelectedReadmePreviews optionally defers branch selection until discovery
// succeeds. Existing DiscoveryPreviews implementations remain supported.
type SelectedReadmePreviews interface {
	PreviewSelectedReadme(context.Context, Access, BranchMatch, bool) (string, error)
}

// Documents is optional. PRs and snippets use the same lifecycle/public-output
// rules, while adapters normalize their native response into the saved schema.
type DocumentRequest struct {
	Access   Access
	Kind, ID string
	Number   int64
}
type Documents interface {
	Provider
	ConnectDocument(context.Context, DocumentRequest, string) (Access, error)
	Document(context.Context, DocumentRequest) (map[string]any, error)
	DocumentURL(DocumentRequest) string
}

var ErrBranchNotFound = errors.New("branch_not_found")

var ErrUnknown = errors.New("provider_not_supported")
var ErrCapability = errors.New("provider_capability_not_supported")
var validID = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

type Registry struct{ entries map[string]Provider }

// New constructs an immutable registry. Duplicate IDs are rejected so an
// extension cannot silently replace GitHub's authentication or authorization.
func New(entries ...Provider) (*Registry, error) {
	r := &Registry{entries: map[string]Provider{}}
	for _, p := range entries {
		if nilProvider(p) {
			return nil, errors.New("invalid_provider_id")
		}
		id := p.ID()
		if !validID.MatchString(id) {
			return nil, errors.New("invalid_provider_id")
		}
		if _, ok := r.entries[id]; ok {
			return nil, errors.New("duplicate_provider_id")
		}
		r.entries[id] = p
	}
	return r, nil
}

func nilProvider(p Provider) bool {
	if p == nil {
		return true
	}
	value := reflect.ValueOf(p)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	}
	return false
}
func (r *Registry) Get(id string) (Provider, error) {
	p, ok := r.entries[id]
	if !ok {
		return nil, ErrUnknown
	}
	return p, nil
}
func (r *Registry) Repositories(id string) (Repositories, error) {
	p, e := r.Get(id)
	if e != nil {
		return nil, e
	}
	v, ok := p.(Repositories)
	if !ok {
		return nil, ErrCapability
	}
	return v, nil
}
func (r *Registry) All() []Provider {
	out := make([]Provider, 0, len(r.entries))
	for _, id := range r.IDs() {
		out = append(out, r.entries[id])
	}
	return out
}

// IDs returns a sorted copy of the registered names. Adapter methods cannot
// rename registry entries or change capability routing after registration.
func (r *Registry) IDs() []string {
	ids := make([]string, 0, len(r.entries))
	for id := range r.entries {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
