package server

import (
	"errors"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"strings"
)

func (s *Server) saveRepositorySource(q *request, previous, source M) (M, M, error) {
	id, e := sourceProvider(source)
	if previous != nil && source["provider"] == nil {
		id, e = sourceProvider(obj(previous["source"]))
	}
	if e != nil {
		return nil, nil, e
	}
	if previous != nil {
		existing, e := sourceProvider(obj(previous["source"]))
		if e != nil {
			return nil, nil, e
		}
		if source["provider"] == nil {
			id = existing
		} else if id != existing {
			return nil, nil, fail("provider_binding_mismatch", 409)
		}
	}
	reconnect, reconnectID, e := validateRepositoryReconnect(q, previous, id)
	if e != nil {
		return nil, nil, e
	}
	p, e := s.providers.Repositories(id)
	if e != nil {
		return nil, nil, providerFailure(e)
	}
	owner := q.User["_id"]
	if previous != nil {
		owner = previous["owner"]
	}
	name := str(q.Body["fullName"])
	branch, commit := str(source["branch"]), str(source["commit"])
	if branch == "" {
		return nil, nil, fail("branch_not_specified", 400)
	}
	if commit == "" || len(commit) > 256 {
		return nil, nil, fail("invalid_commit_format", 400)
	}
	if id == "github" && !commitID.MatchString(commit) {
		return nil, nil, fail("invalid_commit_format", 400)
	}
	if previous != nil && name != str(obj(previous["source"])["repositoryName"]) && q.Identity.ID != str(owner) {
		return nil, nil, fail("not_owner", 403)
	}
	var access provider.Access
	choice := str(q.Body["connection"])
	if previous != nil && !reconnect && name == str(obj(previous["source"])["repositoryName"]) {
		access, e = s.providerAccess(previous)
		if e == nil {
			access, e = s.resolveSourceIdentity(q.ctx(), previous, access)
		}
		if e != nil {
			return nil, nil, e
		}
	} else {
		if previous != nil {
			old, e := s.providerAccess(previous)
			if e != nil {
				return nil, nil, e
			}
			choice = str(old.Binding["kind"])
		}
		connected, e := p.Connect(q.ctx(), provider.ConnectRequest{OwnerID: str(owner), Name: name, Connection: choice})
		if e != nil {
			return nil, nil, e
		}
		access, e = connectionAccess(str(owner), id, connected)
		if e != nil {
			return nil, nil, e
		}
		access.Ref.Name = name
	}
	access.Ref.Branch = branch
	access.Ref.Commit = commit
	if e = p.Authorize(q.ctx(), access); e != nil {
		return nil, nil, e
	}
	metadata, e := p.Repository(q.ctx(), access)
	if e != nil {
		return nil, nil, e
	}
	if e := validateRepositoryIdentity(access, metadata); e != nil {
		return nil, nil, e
	}
	access.Ref.Name = metadata.Name
	access.Ref.ID = metadata.ID
	if reconnect {
		if reconnectID != externalRepositoryID(id, metadata.ID) {
			return nil, nil, fail("connection_changed", 409)
		}
		if _, e = p.Branch(q.ctx(), access, branch); e != nil {
			if errors.Is(e, provider.ErrBranchNotFound) {
				return nil, nil, fail("branch_not_specified", 400)
			}
			return nil, nil, providerFailure(e)
		}
	}
	verified, e := p.Commit(q.ctx(), access, commit)
	if e != nil {
		return nil, nil, e
	}

	cached, e := s.cacheProviderRepository(q, id, metadata)
	if e != nil {
		return nil, nil, e
	}
	kind := "Provider"
	if id == "github" {
		kind = "GitHubStream"
	}
	saved := M{"type": kind, "branch": branch, "commit": verified.ID, "commitDate": verified.Date, "repositoryName": metadata.Name, "repositoryId": str(cached["id"]), "providerRepositoryId": metadata.ID}
	if id != "github" {
		saved["provider"] = id
	}
	return saved, M(access.Binding), nil
}
func externalRepositoryID(id, value string) string {
	if id == "github" {
		return "gh_" + value
	}
	return id + "_" + value
}
func (s *Server) cacheProviderRepository(q *request, id string, r provider.Repository) (M, error) {
	external := externalRepositoryID(id, r.ID)
	set := M{"name": r.Name, "url": r.URL, "source": id, "defaultBranch": r.DefaultBranch, "size": r.Size, "hasPage": r.HasPage}
	if r.PageBranch != "" {
		set["pageSource"] = M{"branch": r.PageBranch, "path": r.PagePath}
	}
	var cached M
	e := s.Store.DB.Collection("repositories").FindOneAndUpdate(q.ctx(), M{"externalId": external}, M{"$set": set, "$setOnInsert": M{"_id": bson.NewObjectID()}}, options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&cached)
	if e != nil {
		return nil, e
	}
	return providerRepositoryJSON(id, r, cached), nil
}
func providerRepositoryJSON(id string, r provider.Repository, cached M) M {
	external := externalRepositoryID(id, r.ID)
	parts := strings.Split(r.Name, "/")
	owner, name := "", r.Name
	if len(parts) > 1 {
		owner = strings.Join(parts[:len(parts)-1], "/")
		name = parts[len(parts)-1]
	}
	out := M{"id": cached["_id"], "externalId": external, "repo": name, "owner": owner, "fullName": r.Name, "defaultBranch": r.DefaultBranch, "size": r.Size, "hasPage": r.HasPage}
	if v, ok := cached["pageSource"]; ok {
		out["pageSource"] = v
	}
	if id != "github" {
		out["provider"] = id
	}
	return out
}

func (s *Server) saveDocumentSource(q *request, kind string, previous, source M, owner any) (M, M, error) {
	if previous != nil {
		source = obj(previous["source"])
	}
	id, e := sourceProvider(source)
	if e != nil {
		return nil, nil, e
	}
	if previous != nil && source["provider"] == nil {
		id, e = sourceProvider(obj(previous["source"]))
		if e != nil {
			return nil, nil, e
		}
	}
	saved := selectFields(source, "gistId", "repositoryFullName", "pullRequestId")
	// Only a prior server-owned source may supply an immutable provider ID.
	// New request bodies cannot choose the identity returned by ConnectDocument.
	if previous != nil {
		if value := obj(previous["source"])["providerRepositoryId"]; value != nil {
			saved["providerRepositoryId"] = value
		}
	}
	if kind == "pr" {
		saved["pullRequestId"] = normalizedIntegerInput(saved["pullRequestId"])
	}
	if id != "github" {
		saved["provider"] = id
	}
	record := M{"owner": owner, "source": saved}
	choice := str(q.Body["connection"])
	if previous != nil {
		old := obj(previous["source"])
		if str(old["repositoryFullName"]) == str(source["repositoryFullName"]) {
			record["githubAccess"] = previous["githubAccess"]
			record["providerAccess"] = previous["providerAccess"]
		}
		a, err := s.providerAccess(previous)
		if err != nil {
			return nil, nil, err
		}
		choice = str(a.Binding["kind"])
	}
	p, req, e := s.documentProvider(record, kind)
	if e != nil {
		return nil, nil, e
	}
	a, e := p.ConnectDocument(q.ctx(), req, choice)
	if e != nil {
		return nil, nil, e
	}
	if a.Ref.Provider != id || a.OwnerID != str(owner) {
		return nil, nil, fail("provider_binding_mismatch", 409)
	}
	if _, e := connectionAccess(str(owner), id, provider.Connection{Ref: a.Ref, Binding: a.Binding}); e != nil {
		return nil, nil, e
	}
	if req.Access.Ref.ID != "" && a.Ref.ID != req.Access.Ref.ID {
		return nil, nil, fail("connection_changed", 409)
	}
	if a.Ref.ID != "" {
		saved["providerRepositoryId"] = a.Ref.ID
	}
	return saved, M(a.Binding), nil
}
