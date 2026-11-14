package server

import (
	"strings"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

// Saved-source previews use the resource owner's binding only after local edit
// authorization. A reconnect deliberately creates a new binding for the owner.
func (s *Server) previewRepositoryAccess(q *request, p provider.Repositories, id, name string) (provider.Access, error) {
	query := parseExtendedQuery(q.R.URL.RawQuery).object
	owner, choice := str(q.User["_id"]), ""
	if resourceID, present := query["anonymizedRepoId"].scalarValue(); present {
		resource, err := s.Store.one(q.ctx(), collection("repo"), resourceFilter("repo", resourceID))
		if err != nil {
			return provider.Access{}, err
		}
		if resource == nil {
			return provider.Access{}, fail("repo_not_found", 404)
		}
		if !canEdit(q.Identity, resource) {
			return provider.Access{}, fail("not_authorized", 403)
		}
		access, err := s.providerAccess(resource)
		if err != nil {
			return access, err
		}
		if access.Ref.Provider != id {
			return access, fail("provider_binding_mismatch", 409)
		}
		sameName := access.Ref.Name == name
		if id == "github" {
			sameName = strings.EqualFold(access.Ref.Name, name)
		}
		if !sameName {
			return access, fail("repo_not_found", 404)
		}
		reconnect, _ := query["reconnect"].scalarValue()
		if reconnect != "1" {
			access, err = s.resolveSourceIdentity(q.ctx(), resource, access)
			if err != nil {
				return access, err
			}
			hint, err := s.previewRepositoryHint(q, id)
			if err != nil {
				return access, err
			}
			if hint != nil {
				// An external cache hint cannot establish or replace the
				// identity of a saved resource using its owner's binding.
				if access.Ref.ID == "" || access.Ref.ID != hint.ID {
					return access, fail("connection_changed", 409)
				}
				access.Ref.ID, access.Ref.Name = hint.ID, hint.Name
			}
			return access, nil
		}
		if q.Identity.ID != str(resource["owner"]) {
			return access, fail("not_owner", 403)
		}
		if resource["status"] == "archived" {
			return access, fail("repository_archived", 410)
		}
		owner, name, choice = access.OwnerID, access.Ref.Name, str(access.Binding["kind"])
		if id == "github" && choice == "" {
			choice = "oauth"
		}
	} else {
		if id == "github" && !safeRepositoryName(name) {
			return provider.Access{}, fail("repo_not_found", 400)
		}
		var err error
		choice, err = previewConnectionChoice(query["connection"], id)
		if err != nil {
			return provider.Access{}, err
		}
	}
	hint, err := s.previewRepositoryHint(q, id)
	if err != nil {
		return provider.Access{}, err
	}
	request := provider.ConnectRequest{OwnerID: owner, Name: name, Connection: choice}
	if hint != nil {
		request.Name, request.RepositoryID = hint.Name, hint.ID
	}
	connected, err := p.Connect(q.ctx(), request)
	if err != nil {
		return provider.Access{}, err
	}
	access, err := connectionAccess(owner, id, connected)
	if err != nil {
		return access, err
	}
	if hint != nil {
		if access.Ref.ID != "" && access.Ref.ID != hint.ID {
			return access, fail("connection_changed", 409)
		}
		access.Ref.ID = hint.ID
	}
	return access, nil
}

// Cache IDs select metadata only. They never supply credentials or skip the
// adapter's Connect, Authorize and Repository checks.
func (s *Server) previewRepositoryHint(q *request, id string) (*provider.Ref, error) {
	filter, err := previewHintFilter(q.R.URL.RawQuery)
	if err != nil || filter == nil {
		return nil, err
	}
	cached, err := s.Store.one(q.ctx(), "repositories", filter)
	if err != nil || cached == nil {
		return nil, err
	}
	prefix := externalRepositoryID(id, "")
	external := str(cached["externalId"])
	if declared := str(cached["source"]); declared != "" && declared != id {
		return nil, fail("provider_binding_mismatch", 409)
	}
	if !strings.HasPrefix(external, prefix) || len(external) == len(prefix) {
		return nil, fail("provider_binding_mismatch", 409)
	}
	name := str(cached["name"])
	if name == "" {
		return nil, fail("provider_invalid_response", 502)
	}
	return &provider.Ref{Provider: id, ID: strings.TrimPrefix(external, prefix), Name: name}, nil
}

// Provider connection names stay opaque outside the GitHub adapter's legacy
// choices. Query arrays/objects must never select a credential by their first item.
func previewConnectionChoice(value *queryValue, id string) (string, error) {
	if value == nil {
		return "", nil
	}
	choice, scalar := value.scalarValue()
	if !scalar || id == "github" && choice != "oauth" && choice != "github-app" {
		return "", fail("invalid_connection", 400)
	}
	return choice, nil
}
