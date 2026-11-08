package server

import (
	"context"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"io"
)

type archiveProvider struct{ server *Server }

func (p *archiveProvider) ID() string { return "archive" }
func (p *archiveProvider) Connect(context.Context, provider.ConnectRequest) (provider.Connection, error) {
	return provider.Connection{}, fail("archive_upload_required", 400)
}
func (p *archiveProvider) Authorize(ctx context.Context, a provider.Access) error {
	owner, e := oid(a.OwnerID)
	if e != nil {
		return fail("not_authorized", 403)
	}
	user, e := p.server.Store.one(ctx, "users", M{"_id": owner})
	if e != nil {
		return e
	}
	if !identity(user).Active() {
		return fail("not_authorized", 403)
	}
	return nil
}
func (p *archiveProvider) Repository(context.Context, provider.Access) (provider.Repository, error) {
	return provider.Repository{}, provider.ErrCapability
}
func (p *archiveProvider) Commit(context.Context, provider.Access, string) (provider.Commit, error) {
	return provider.Commit{}, provider.ErrCapability
}
func (p *archiveProvider) Tree(ctx context.Context, a provider.Access) ([]provider.Entry, error) {
	rows, e := p.server.content.List(ctx, a.Ref.AnonymousID)
	if e != nil {
		return nil, e
	}
	out := make([]provider.Entry, 0, len(rows))
	for _, r := range rows {
		out = append(out, provider.Entry{Path: r.Path, Size: r.Size})
	}
	return out, nil
}
func (p *archiveProvider) Open(ctx context.Context, a provider.Access, f provider.Entry) (io.ReadCloser, error) {
	body, e := p.server.content.Read(ctx, a.Ref.AnonymousID, f.Path)
	if e != nil {
		return nil, e
	}
	return checkedBody(body, f.Size), nil
}
func (p *archiveProvider) PublicURL(provider.Ref) string   { return "" }
func (p *archiveProvider) SelfLinks(provider.Ref) []string { return []string{} }

func (p *archiveProvider) Branch(context.Context, provider.Access, string) (provider.Commit, error) {
	return provider.Commit{}, provider.ErrCapability
}
