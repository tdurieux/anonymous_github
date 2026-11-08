package server

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"strings"
	"time"
)

func membership(q *request, kind string) M {
	if kind != "repo" {
		return M{"owner": q.User["_id"]}
	}
	return repositoryMembership(q.User)
}
func (s *Server) userResources(kind string) handler {
	return func(q *request) (any, error) {
		rows, err := s.Store.list(q.ctx(), collection(kind), membership(q, kind), 0, nil)
		if err != nil {
			return nil, err
		}
		rows, err = s.markListExpired(q.ctx(), kind, rows)
		if err != nil {
			return nil, err
		}
		out := []M{}
		for _, r := range rows {
			v := resourceJSON(kind, r)
			if kind == "repo" {
				v["role"] = "coauthor"
				if str(r["owner"]) == q.Identity.ID {
					v["role"] = "owner"
				}
			}
			key := projectNameKey(kind, str(r[idKey(kind)]))
			if name, ok := obj(q.User["projectNames"])[key]; ok {
				v["projectName"] = name
			}
			out = append(out, v)
		}
		return out, nil
	}
}
func (s *Server) projectName(q *request) (any, error) {
	kind, id, name, err := validateProjectName(q.Body)
	if err != nil {
		return nil, err
	}
	rows, err := s.Store.list(q.ctx(), collection(kind), membership(q, kind), 0, nil)
	if err != nil {
		return nil, err
	}
	rows, err = s.markListExpired(q.ctx(), kind, rows)
	if err != nil {
		return nil, err
	}
	authorized := false
	for _, row := range rows {
		if str(row[idKey(kind)]) == id {
			authorized = true
			break
		}
	}
	if !authorized {
		return nil, fail("not_authorized", 403)
	}
	key := projectNameKey(kind, id)
	update := M{"$set": M{"projectNames." + key: name}}
	if name == "" {
		update = M{"$unset": M{"projectNames." + key: ""}}
	}
	if _, err = s.Store.update(q.ctx(), "users", M{"_id": q.User["_id"]}, update); err != nil {
		return nil, err
	}
	s.dashboardNames.clear()
	filter := M{"owner": q.User["_id"], "type": kind, "artifactId": id}
	if name == "" {
		_, err = s.Store.DB.Collection("dashboardnames").DeleteOne(q.ctx(), filter)
	} else {
		_, err = s.Store.DB.Collection("dashboardnames").UpdateOne(q.ctx(), filter, M{"$set": M{"name": name}}, options.UpdateOne().SetUpsert(true))
	}
	return M{"name": name}, err
}
func (s *Server) githubUsers(q *request) (any, error) {
	query, search, err := userSearchQuery(q.R.URL.RawQuery)
	if err != nil {
		return nil, err
	}
	if !search {
		return []any{}, nil
	}
	token, err := s.userToken(q.ctx(), q.User["_id"])
	if err != nil {
		return nil, err
	}
	path, err := userSearchPath(query)
	if err != nil {
		return nil, err
	}
	data, err := s.githubObject(q.ctx(), "GET", path, token, nil)
	if err != nil {
		return nil, err
	}
	out := []M{}
	for _, v := range arr(data["items"]) {
		u := obj(v)
		out = append(out, M{"username": u["login"], "githubId": str(u["id"]), "photo": u["avatar_url"]})
	}
	return out, nil
}

// JavaScript String.length counts UTF-16 code units, not UTF-8 bytes or
// Unicode characters. Stop once the search route's two-unit minimum is met.
func githubUserSearchable(query string) bool {
	units := 0
	for _, r := range query {
		units++
		if r > 0xffff {
			units++
		}
		if units >= 2 {
			return true
		}
	}
	return false
}

func (s *Server) allRepositories(q *request) (any, error) {
	owner := q.User["_id"]
	if username := q.Params["username"]; username != "" && username != q.Identity.Username {
		if !q.Identity.Admin {
			return nil, fail("not_authorized", 403)
		}
		u, err := s.Store.one(q.ctx(), "users", M{"username": username})
		if err != nil {
			return nil, err
		}
		if u == nil {
			return nil, fail("user_not_found", 404)
		}
		owner = u["_id"]
	}

	id := q.Params["provider"]
	if id == "" {
		id = "github"
	}
	p, e := s.providers.Get(id)
	if e != nil {
		return nil, providerFailure(e)
	}
	d, ok := p.(provider.Discovery)
	if !ok {
		return nil, providerFailure(provider.ErrCapability)
	}
	force, err := parseExtendedQuery(q.R.URL.RawQuery).object["force"].looseStringEqual("1")
	if err != nil {
		return nil, err
	}
	repos, e := d.List(q.ctx(), provider.ListRequest{OwnerID: str(owner), Force: force})
	if e != nil {
		return nil, e
	}
	out := []M{}
	for _, r := range repos {
		out = append(out, M{"fullName": r.Name, "id": externalRepositoryID(id, r.ID)})
	}
	return out, nil
}

func (s *Server) coauthors(q *request) (any, error) {
	r, original, err := coauthorResource(q)
	if err != nil {
		return nil, err
	}
	list := arr(r["coauthors"])
	if q.R.Method == "GET" {
		if !canEdit(q.Identity, r) {
			return nil, fail("not_authorized", 403)
		}
		return list, nil
	}
	owner := q.Identity.Owns(str(r["owner"]))
	if q.R.Method == "POST" {
		if !owner {
			return nil, fail("not_authorized", 401)
		}
		username := strings.TrimSpace(str(q.Body["username"]))
		if username == "" {
			return nil, fail("username_not_defined", 400)
		}
		token, err := s.userToken(q.ctx(), q.User["_id"])
		if err != nil {
			return nil, err
		}
		user, err := s.githubObject(q.ctx(), "GET", "/users/"+segment(username), token, nil)
		if err != nil {
			return nil, fail("github_user_not_found", 404)
		}
		name := str(user["login"])
		if strings.EqualFold(name, q.Identity.Username) {
			return nil, fail("cannot_coauthor_self", 400)
		}
		for _, v := range list {
			if strings.EqualFold(str(obj(v)["username"]), name) {
				return list, nil
			}
		}
		list = append(list, M{"username": name, "githubId": str(user["id"]), "photo": user["avatar_url"], "addedAt": time.Now()})
	} else {
		target := q.Params["username"]
		if !owner && !coauthorSelf(q.Identity, list, target) {
			return nil, fail("not_authorized", 401)
		}
		keep := []any{}
		for _, v := range list {
			if !strings.EqualFold(str(obj(v)["username"]), target) {
				keep = append(keep, v)
			}
		}
		list = keep
	}
	filter := revisionFilter(r)
	filter["coauthors"] = original
	ok, err := s.Store.update(q.ctx(), "anonymizedrepositories", filter, M{"$set": M{"coauthors": list}})
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fail("repository_changed", 409)
	}
	return list, nil
}
func (s *Server) tokens(q *request) (any, error) {
	if q.R.Method == "GET" {
		current, err := s.Store.one(q.ctx(), "users", M{"_id": q.User["_id"]})
		if err != nil {
			return nil, err
		}
		if current == nil {
			return nil, fail("user_not_found", 404)
		}
		list := arr(current["apiTokens"])
		out := []M{}
		for _, v := range list {
			t := obj(v)
			m := selectFields(t, "name", "createdAt", "lastUsedAt")
			m["id"] = t["_id"]
			out = append(out, m)
		}
		return out, nil
	}
	if q.R.Method == "DELETE" {
		id, err := oid(q.Params["id"])
		if err != nil {
			return nil, fail("internal_error", 500)
		}
		r, err := s.Store.DB.Collection("users").UpdateOne(q.ctx(), M{"_id": q.User["_id"]}, M{"$pull": M{"apiTokens": M{"_id": id}}})
		if err != nil {
			return nil, err
		}
		return M{"removed": r.ModifiedCount}, nil
	}
	token, err := security.RandomToken()
	if err != nil {
		return nil, err
	}
	name, err := adminTokenName(q.Body["name"])
	if err != nil {
		return nil, err
	}
	entry := M{"_id": bson.NewObjectID(), "tokenHash": security.HashToken(token), "name": name, "createdAt": time.Now()}
	matched, err := s.Store.update(q.ctx(), "users", M{"_id": q.User["_id"]}, M{"$push": M{"apiTokens": entry}})
	if err != nil {
		return nil, err
	}
	if !matched {
		return nil, fail("user_not_found", 404)
	}
	return M{"id": entry["_id"], "name": name, "createdAt": entry["createdAt"], "token": token}, nil
}

func projectNameKey(kind, id string) string {
	digest := sha256.Sum256([]byte(kind + ":" + id))
	return hex.EncodeToString(digest[:])
}
