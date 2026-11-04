package server

import (
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
	"strings"
	"time"
)

func (s *Server) maintenanceResource(q *request) (any, error) {
	q.W.Header().Set("Cache-Control", "no-store")
	r, e := q.resource("repo", true)
	if e != nil {
		return nil, e
	}
	if q.R.Method == "GET" {
		out := selectFields(r, "repoId", "status", "statusMessage", "statusDate", "settingsSavedAt", "options")
		out["source"] = selectFields(obj(r["source"]), "branch", "commit")
		return out, nil
	}
	if str(r["status"]) != "ready" && str(r["status"]) != "error" {
		return nil, fail("invalid_status", 409)
	}
	if len(q.Body) == 0 {
		return nil, fail("invalid_settings", 400)
	}
	set := M{}
	for k, v := range q.Body {
		switch k {
		case "terms":
			terms, ok := v.([]any)
			if !ok || len(terms) > 1000 {
				return nil, fail("invalid_settings", 400)
			}
			for _, t := range terms {
				text, ok := t.(string)
				if !ok || text == "" || len([]rune(text)) > 1000 {
					return nil, fail("invalid_settings", 400)
				}
			}
		case "update", "image", "pdf", "notebook", "link":
			if _, ok := v.(bool); !ok {
				return nil, fail("invalid_settings", 400)
			}
		default:
			return nil, fail("invalid_settings", 400)
		}
		set["options."+k] = v
	}
	now := time.Now()
	set["settingsSavedAt"] = now
	ok, e := s.Store.update(q.ctx(), collection("repo"), revisionFilter(r), M{"$set": set})
	if e != nil {
		return nil, e
	}
	if !ok {
		return nil, fail("invalid_status", 409)
	}
	return M{"repoId": r["repoId"], "status": r["status"], "settingsSavedAt": now}, nil
}
func (s *Server) maintenanceTokens(q *request) (any, error) {
	q.W.Header().Set("Cache-Control", "no-store")
	if q.R.Header.Get("Authorization") != "" || q.SessionID == "" {
		return nil, fail("session_required", 401)
	}
	if q.R.Method == "GET" {
		out := []M{}
		for _, v := range arr(q.User["apiTokens"]) {
			t := obj(v)
			if str(t["scope"]) == "repository-maintenance" {
				m := selectFields(t, "name", "repoIds", "expiresAt", "createdAt", "lastUsedAt")
				m["id"] = t["_id"]
				out = append(out, m)
			}
		}
		return out, nil
	}
	if q.R.Method == "DELETE" {
		id, e := oid(q.Params["id"])
		if e != nil {
			return nil, fail("invalid_token_id", 400)
		}
		result, e := s.Store.DB.Collection("users").UpdateOne(q.ctx(), M{"_id": q.User["_id"]}, M{"$pull": M{"apiTokens": M{"_id": id, "scope": "repository-maintenance"}}})
		if e != nil {
			return nil, e
		}
		return M{"removed": result.ModifiedCount}, nil
	}
	name := str(q.Body["name"])
	ids := stringsOf(q.Body["repoIds"])
	days := number(q.Body["expiresInDays"])
	if q.Body["expiresInDays"] == nil {
		days = 30
	}
	if strings.TrimSpace(name) == "" || len([]rune(name)) > 80 || len(ids) == 0 || len(ids) > 20 || days < 1 || days > 90 {
		return nil, fail("invalid_token_options", 400)
	}
	seen := map[string]bool{}
	unique := []string{}
	for _, id := range ids {
		if !resourceID.MatchString(id) {
			return nil, fail("invalid_token_options", 400)
		}
		r, e := s.Store.one(q.ctx(), collection("repo"), resourceFilter("repo", id))
		if e != nil {
			return nil, e
		}
		if r == nil {
			return nil, fail("repo_not_found", 404)
		}
		if !canEdit(q.Identity, r) {
			return nil, fail("not_authorized", 403)
		}
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	token, e := security.RandomToken()
	if e != nil {
		return nil, e
	}
	entry := M{"_id": bson.NewObjectID(), "name": strings.TrimSpace(name), "scope": "repository-maintenance", "repoIds": unique, "tokenHash": security.HashToken(token), "createdAt": time.Now(), "expiresAt": time.Now().Add(time.Duration(days) * 24 * time.Hour)}
	ok, e := s.Store.update(q.ctx(), "users", M{"_id": q.User["_id"], "apiTokens.50": M{"$exists": false}}, M{"$push": M{"apiTokens": entry}})
	if e != nil {
		return nil, e
	}
	if !ok {
		return nil, fail("token_limit_reached", 409)
	}
	q.W.Header().Set("Content-Type", "application/json; charset=utf-8")
	writeJSONStatus(q.W, M{"id": entry["_id"], "name": entry["name"], "repoIds": unique, "expiresAt": entry["expiresAt"], "token": token}, 201)
	return written{}, nil
}
