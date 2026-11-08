package server

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"io"
	"net/http"
	"net/url"
	"time"
)

func (s *Server) connections(q *request) (any, error) {
	if q.R.Method != "GET" {
		csrf := str(q.Session["githubConnectionCSRF"])
		if csrf == "" || subtle.ConstantTimeCompare([]byte(csrf), []byte(q.R.Header.Get("X-CSRF-Token"))) != 1 {
			return nil, fail("invalid_auth_state", 403)
		}
	}
	if q.R.Method == "GET" {
		if str(q.Session["githubConnectionCSRF"]) == "" {
			token, e := security.RandomToken()
			if e != nil {
				return nil, e
			}
			q.Session["githubConnectionCSRF"] = token
		}
		if e := q.saveSession(false); e != nil {
			return nil, e
		}
		grants, e := s.connectionGrants(q.ctx(), q.User["_id"])
		if e != nil {
			return nil, e
		}
		app, seenApp := false, false
		for _, g := range grants {
			if str(g["provider"]) == "github-app-user" {
				seenApp = true
				app = !boolean(g["revoked"])
			}
		}
		oauthToken, e := s.storedGrantToken(q.ctx(), q.User["_id"], "github")
		if e != nil {
			return nil, e
		}
		installations := []M{}
		out := M{"csrf": q.Session["githubConnectionCSRF"], "appEnabled": s.Config.AppEnabled && s.Config.AppNewConnections, "oauthEnabled": s.Config.OAuthEnabled, "oauthConnected": oauthToken != "", "appConnected": app, "gistConnection": "oauth"}
		if seenApp && s.Config.AppEnabled {
			out["gistConnection"] = "github-app"
		}
		if app && s.Config.AppEnabled {
			items, e := s.installations(q.ctx(), q.User["_id"])
			if e != nil {
				out["appError"] = "github_app_reconnect_required"
				var api *APIError
				if errors.As(e, &api) {
					out["appError"] = api.Code
				}
			} else {
				for _, v := range items {
					installations = append(installations, M{"id": v["id"], "account": obj(v["account"])["login"], "suspended": inputTruthy(v["suspended_at"])})
				}
			}
		}
		out["installations"] = installations
		resources, e := s.connectionResources(q.ctx(), q.User["_id"])
		if e != nil {
			return nil, e
		}
		count, e := s.Store.DB.Collection(collection("gist")).CountDocuments(q.ctx(), githubSources(M{"owner": q.User["_id"], "status": M{"$ne": "removed"}}))
		if e != nil {
			return nil, e
		}
		out["gistCount"] = count
		out["resources"] = resources
		return out, nil
	}
	if q.R.URL.Path == "/github/connections/disconnect-oauth" {
		if _, e := s.installations(q.ctx(), q.User["_id"]); e != nil {
			return nil, fail("another_login_required", 409)
		}
		for _, kind := range []string{"repo", "pr"} {
			r, e := s.Store.one(q.ctx(), collection(kind), githubSources(M{"owner": q.User["_id"], "status": M{"$ne": "removed"}, "githubAccess.kind": M{"$ne": "github-app"}}))
			if e != nil {
				return nil, e
			}
			if r != nil {
				return nil, fail("oauth_resources_remaining", 409)
			}
		}
		if e := s.revokeGrant(q.ctx(), q.User["_id"], "github"); e != nil {
			return nil, e
		}
		return M{"disconnected": true}, nil
	}
	resourceID, validID := q.Body["id"].(string)
	if !validID {
		return nil, fail("invalid_connection", 400)
	}
	kind := "repo"
	if str(q.Body["type"]) == "pull-request" {
		kind = "pr"
	} else if str(q.Body["type"]) != "repository" {
		return nil, fail("invalid_connection", 400)
	}
	conn := str(q.Body["connection"])
	if conn != "oauth" && conn != "github-app" {
		return nil, fail("invalid_connection", 400)
	}
	if conn == "github-app" && (!s.Config.AppEnabled || !s.Config.AppNewConnections) {
		return nil, fail("github_app_disabled", 503)
	}
	filter := resourceFilter(kind, resourceID)
	filter["owner"] = q.User["_id"]
	var raw bson.Raw
	findOptions := options.FindOne()
	if kind == "repo" {
		findOptions.SetCollation(&options.Collation{Locale: "en", Strength: 2})
	}
	e := s.Store.DB.Collection(collection(kind)).FindOne(q.ctx(), filter, findOptions).Decode(&raw)
	if errors.Is(e, mongo.ErrNoDocuments) {
		return nil, fail("repo_not_found", 404)
	}
	if e != nil {
		return nil, e
	}
	var r M
	if e = bson.Unmarshal(raw, &r); e != nil {
		return nil, e
	}
	if r == nil || str(r["status"]) == "removed" || str(r["status"]) == "archived" {
		return nil, fail("repo_not_found", 404)
	}
	stalePR := kind == "pr" && str(r["status"]) == "download" && (date(r["statusDate"]).IsZero() || !date(r["statusDate"]).After(time.Now().Add(-5*time.Minute)))
	if !stalePR {
		switch str(r["status"]) {
		case "preparing", "queue", "download", "removing", "expiring":
			return nil, fail("repository_busy", 409)
		}
	}
	source := obj(r["source"])
	id, e := sourceProvider(source)
	if e != nil {
		return nil, e
	}
	if id != "github" {
		return nil, fail("provider_capability_not_supported", 400)
	}
	name := str(source["repositoryName"])
	if kind == "pr" {
		name = str(source["repositoryFullName"])
	}
	old := obj(r["githubAccess"])
	repositoryID := ""
	if str(old["kind"]) == "github-app" && conn == "github-app" {
		repositoryID = str(old["repositoryId"])
	}
	token, binding, fullName, e := s.selectAccessIdentity(q.ctx(), q.User["_id"], name, conn, repositoryID)
	if e != nil {
		return nil, e
	}
	if str(old["kind"]) == "github-app" && conn == "github-app" && str(old["repositoryId"]) != str(binding["repositoryId"]) {
		return nil, fail("connection_changed", 409)
	}
	resolvedName := name
	if fullName != "" {
		resolvedName = fullName
	}
	endpoint := "/repos/" + resolvedName + "/commits/" + segment(str(source["commit"]))
	if kind == "pr" {
		endpoint = "/repos/" + resolvedName + "/pulls/" + segment(str(source["pullRequestId"]))
	}
	if _, e = s.github(q.ctx(), "GET", endpoint, token, nil); e != nil {
		return nil, e
	}
	if boolean(q.Body["preview"]) {
		return M{"eligible": true, "connection": conn}, nil
	}
	if kind == "repo" && source["repositoryId"] != nil && fullName != "" && str(binding["kind"]) == "github-app" {
		cachedID, err := oid(str(source["repositoryId"]))
		if err != nil {
			return nil, err
		}
		if _, err = s.Store.update(q.ctx(), "repositories", M{"_id": cachedID, "externalId": "gh_" + str(binding["repositoryId"])}, M{"$set": M{"name": fullName, "url": "https://github.com/" + fullName}}); err != nil {
			return nil, err
		}
	}
	cas := revisionFilter(r)
	cas["source"] = raw.Lookup("source")
	if bindingValue, err := raw.LookupErr("githubAccess"); err == nil {
		cas["githubAccess"] = bindingValue
	} else {
		cas["githubAccess"] = M{"$exists": false}
	}
	cas["owner"] = q.User["_id"]
	fields := M{"githubAccess": binding}
	if fullName != "" && fullName != name {
		field := "source.repositoryName"
		if kind == "pr" {
			field = "source.repositoryFullName"
		}
		fields[field] = fullName
	}
	ok, e := s.Store.update(q.ctx(), collection(kind), cas, M{"$set": fields})
	if e != nil {
		return nil, e
	}
	if !ok {
		return nil, fail("connection_changed", 409)
	}
	return M{"connection": conn}, nil
}
func (s *Server) appInstall(q *request) (any, error) {
	if !s.Config.AppEnabled || !s.Config.AppNewConnections {
		return nil, fail("github_app_disabled", 503)
	}
	if q.R.URL.Path == "/github/app/setup" {
		flow := obj(q.Session["githubInstallFlow"])
		delete(q.Session, "githubInstallFlow")
		if e := q.saveSession(false); e != nil {
			return nil, e
		}
		if !q.Identity.Active() {
			return q.redirect("/github/app/login"), nil
		}
		query := parseExtendedQuery(q.R.URL.RawQuery).object
		state, scalarState := query["state"].scalarValue()
		owned := str(flow["ownerId"]) == q.Identity.ID && number(flow["expires"]) > time.Now().UnixMilli()
		if !query["state"].truthy() {
			if owned {
				return q.redirect(security.ReturnTo(str(flow["returnTo"]), "/connections")), nil
			}
			return q.redirect("/connections"), nil
		}
		if !scalarState || str(flow["ownerId"]) != q.Identity.ID || number(flow["expires"]) < time.Now().UnixMilli() || subtle.ConstantTimeCompare([]byte(state), []byte(str(flow["state"]))) != 1 {
			return nil, fail("invalid_auth_state", 400)
		}
		setupAction, _ := query["setup_action"].scalarValue()
		if setupAction != "request" {
			items, e := s.installations(q.ctx(), q.User["_id"])
			if e != nil {
				return nil, e
			}
			found := false
			for _, v := range items {
				installationID, scalarID := query["installation_id"].scalarValue()
				found = found || (scalarID && str(v["id"]) == installationID)
			}
			if !found {
				return nil, fail("github_app_access_required", 403)
			}
		}
		if _, e := s.Store.update(q.ctx(), "users", M{"_id": q.User["_id"]}, M{"$set": M{"repositories": []any{}}, "$inc": M{"repositoryDiscoveryRevision": 1}}); e != nil {
			return nil, e
		}
		return q.redirect(security.ReturnTo(str(flow["returnTo"]), "/connections")), nil
	}
	if !q.Identity.Active() {
		return nil, fail("not_connected", 401)
	}
	items, e := s.installations(q.ctx(), q.User["_id"])
	if e != nil {
		return nil, e
	}
	query := parseExtendedQuery(q.R.URL.RawQuery).object
	target, e := s.installationTarget(q.ctx(), q.User["_id"], query, items)
	if e != nil {
		return nil, e
	}
	state, e := security.RandomToken()
	if e != nil {
		return nil, e
	}
	returnTo, _ := query["returnTo"].scalarValue()
	q.Session["githubInstallFlow"] = M{"state": state, "ownerId": q.Identity.ID, "expires": time.Now().Add(10 * time.Minute).UnixMilli(), "returnTo": security.ReturnTo(returnTo, "/connections")}
	if e = q.saveSession(false); e != nil {
		return nil, e
	}
	destination, e := url.Parse(target)
	if e != nil {
		return nil, e
	}
	values := destination.Query()
	values.Set("state", state)
	destination.RawQuery = values.Encode()
	return q.redirect(destination.String()), nil
}

// storedGrantToken mirrors the encrypted-token read used by TypeScript's
// connection summary and revocation. It does not refresh or reject old grants.
func (s *Server) storedGrantToken(ctx context.Context, owner any, provider string) (string, error) {
	row, err := s.storedGrantEnvelope(ctx, owner, provider)
	if err != nil {
		return "", err
	}
	if row == nil {
		return "", nil
	}
	encrypted, err := envelope(row["encryptedToken"])
	if err != nil {
		return "", fail("credential_decryption_failed", 500)
	}
	token, err := s.Config.Cipher.Decrypt(encrypted, str(owner), provider, "")
	if err != nil {
		return "", fail("credential_decryption_failed", 500)
	}
	return token, nil
}

func (s *Server) revokeGrant(ctx context.Context, owner any, provider string) error {
	token, e := s.storedGrantToken(ctx, owner, provider)
	if e != nil {
		return e
	}
	if token != "" {
		client, secret := s.Config.ClientID, s.Config.ClientSecret
		if provider == "github-app-user" {
			client, secret = s.Config.AppClientID, s.Config.AppClientSecret
		}
		body, _ := json.Marshal(M{"access_token": token})
		requestCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		req, e := http.NewRequestWithContext(requestCtx, "DELETE", "https://api.github.com/applications/"+url.PathEscape(client)+"/grant", bytes.NewReader(body))
		if e != nil {
			return e
		}
		req.SetBasicAuth(client, secret)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/vnd.github+json")
		resp, e := s.HTTP.Do(req)
		if e != nil {
			return fail("github_grant_revocation_failed", 502)
		}
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if (resp.StatusCode < 200 || resp.StatusCode >= 300) && resp.StatusCode != 404 && resp.StatusCode != 422 {
			return fail("github_grant_revocation_failed", 502)
		}
	}
	if _, e = s.Store.DB.Collection("credentials").DeleteMany(ctx, M{"ownerId": owner, "provider": provider}); e != nil {
		return e
	}
	change := M{"$set": M{"repositories": []any{}}, "$inc": M{"repositoryDiscoveryRevision": 1}}
	if provider == "github" {
		change["$unset"] = M{"accessTokens.github": "", "accessTokenDates.github": ""}
	}
	_, e = s.Store.update(ctx, "users", M{"_id": owner}, change)
	return e
}
func (s *Server) deleteAccount(q *request) (any, error) {
	if err := s.removeAccountResources(q); err != nil {
		return nil, err
	}
	owner := q.User["_id"]
	// Removed records remain as tombstones and may still carry legacy credentials.
	for _, kind := range []string{"repo", "pr", "gist"} {
		if _, err := s.Store.DB.Collection(collection(kind)).UpdateMany(q.ctx(), M{"owner": owner}, M{"$unset": M{"source.accessToken": "", "accessToken": ""}}); err != nil {
			return nil, err
		}
	}
	// Revocation is best effort; it must not uninstall a shared organization App.
	for _, provider := range []string{"github", "github-app-user"} {
		if err := s.revokeGrant(q.ctx(), owner, provider); err != nil {
			s.recordError(q.ctx(), fail("github_grant_revocation_failed", 502))
		}
	}
	if _, err := s.Store.DB.Collection("credentials").DeleteMany(q.ctx(), M{"ownerId": owner}); err != nil {
		return nil, err
	}
	if _, err := s.Store.DB.Collection("dashboardnames").DeleteMany(q.ctx(), M{"owner": owner}); err != nil {
		return nil, err
	}
	_, err := s.Store.update(q.ctx(), "users", M{"_id": owner}, M{"$inc": M{"repositoryDiscoveryRevision": 1}, "$set": M{"status": "removed", "username": "deleted-" + str(owner), "emails": []any{}, "apiTokens": []any{}, "repositories": []any{}}, "$unset": M{"accessTokens": "", "accessTokenDates": "", "externalIDs": "", "photo": "", "default": "", "projectNames": ""}})
	if err != nil {
		return nil, err
	}
	if q.SessionID != "" {
		if err := s.Store.Redis.Del(q.ctx(), "anoGH_session:"+q.SessionID).Err(); err != nil {
			return nil, err
		}
	}
	return M{"status": "ok"}, nil
}
