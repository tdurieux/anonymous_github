package server

import (
	"strconv"
	"strings"
)

func (s *Server) embeddedSource(kind string) handler {
	return func(q *request) (any, error) {
		id := q.Params["provider"]
		if id == "" {
			id = "github"
		}
		source := M{"provider": id, "gistId": q.Params["id"]}
		if kind == "pr" {
			name := q.R.URL.Query().Get("name")
			if q.Params["provider"] == "" {
				name = q.Params["owner"] + "/" + q.Params["repository"]
			}
			n, e := strconv.ParseInt(q.Params["id"], 10, 64)
			if e != nil || n < 1 {
				return nil, fail("pull_request_not_found", 400)
			}
			source = M{"provider": id, "repositoryFullName": name, "pullRequestId": n}
		}
		// Source previews use the same server-owned access binding as creation.
		if q.Body == nil {
			q.Body = M{}
		}
		choice, err := previewConnectionChoice(parseExtendedQuery(q.R.URL.RawQuery).object["connection"], id)
		if err != nil {
			return nil, err
		}
		q.Body["connection"] = choice
		source, binding, e := s.saveDocumentSource(q, kind, nil, source, q.User["_id"])
		if e != nil {
			return nil, e
		}
		record := M{"source": source, "owner": q.User["_id"]}
		if id == "github" {
			record["githubAccess"] = binding
		} else {
			record["providerAccess"] = binding
		}

		payload, e := s.downloadEmbedded(q.ctx(), kind, record)
		if e != nil {
			return nil, e
		}
		field := "gist"
		if kind == "pr" {
			field = "pullRequest"
		}
		record[field] = payload
		out := resourceJSON(kind, record)
		if kind == "pr" {
			out["connection"] = binding["kind"]
		} else {
			out["isPublic"] = payload["isPublic"]
		}
		return out, nil
	}
}

func (s *Server) claim(q *request) (any, error) {
	id := str(q.Body["repoId"])
	if id == "" {
		return nil, fail("repoId_not_defined", 400)
	}
	name := strings.TrimSuffix(strings.TrimPrefix(str(q.Body["repoUrl"]), "https://github.com/"), ".git")
	if !safeRepositoryName(name) {
		return nil, fail("repo_not_found", 404)
	}
	r, e := s.Store.one(q.ctx(), collection("repo"), resourceFilter("repo", id))
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("repo_not_found", 404)
	}
	idProvider, e := sourceProvider(obj(r["source"]))
	if e != nil {
		return nil, e
	}
	if idProvider != "github" {
		return nil, fail("provider_capability_not_supported", 400)
	}
	token, binding, e := s.selectAccess(q.ctx(), q.User["_id"], name, str(q.Body["connection"]))
	if e != nil {
		return nil, e
	}
	upstream, e := s.githubObject(q.ctx(), "GET", "/repos/"+name, token, nil)
	if e != nil {
		return nil, e
	}
	// Public read access alone is not proof of repository ownership.
	userToken, e := s.userToken(q.ctx(), q.User["_id"])
	if e != nil {
		return nil, e
	}
	permissions, e := s.githubObject(q.ctx(), "GET", "/repos/"+name, userToken, nil)
	if e != nil {
		return nil, e
	}
	if !boolean(obj(permissions["permissions"])["admin"]) && !q.Identity.Owns(str(r["owner"])) {
		return nil, fail("repository_admin_required", 403)
	}
	source := obj(r["source"])
	cachedID, e := oid(str(source["repositoryId"]))
	if e != nil {
		return nil, fail("repo_not_found", 404)
	}
	cached, e := s.Store.one(q.ctx(), "repositories", M{"_id": cachedID})
	if e != nil {
		return nil, e
	}
	if str(cached["externalId"]) != "gh_"+str(upstream["id"]) {
		return nil, fail("repo_not_found", 404)
	}
	ok, e := s.Store.update(q.ctx(), collection("repo"), revisionFilter(r), M{"$set": M{"owner": q.User["_id"], "githubAccess": binding}})
	if e != nil {
		return nil, e
	}
	if !ok {
		return nil, fail("connection_changed", 409)
	}
	return q.text("Ok"), nil
}
