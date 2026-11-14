package server

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func identity(user M) security.Identity {
	return security.Identity{ID: str(user["_id"]), Username: str(user["username"]), GitHubID: str(obj(user["externalIDs"])["github"]), Status: str(user["status"]), Admin: boolean(user["isAdmin"])}
}
func (s *Server) authenticate(q *request) error {
	if cookie, err := q.R.Cookie("connect.sid"); err == nil {
		value, err := url.QueryUnescape(cookie.Value)
		if err == nil {
			if sid, ok := security.VerifySession(value, s.Config.SessionSecret); ok {
				raw, err := s.Store.Redis.Get(q.ctx(), "anoGH_session:"+sid).Bytes()
				if err != nil && !errors.Is(err, redis.Nil) {
					return fail("session_unavailable", 503)
				}
				if err == nil && json.Unmarshal(raw, &q.Session) == nil {
					q.SessionID = sid
					id, ok := obj(q.Session["passport"])["user"].(string)
					if ok {
						if oid, err := oid(id); err == nil {
							user, err := s.Store.one(q.ctx(), "users", M{"_id": oid})
							if err != nil {
								return fail("session_unavailable", 503)
							}
							if identity(user).Active() {
								q.User = user
								q.Identity = identity(user)
								if err := q.refreshSession(raw); err != nil {
									return err
								}
							}
						}
					}
				}
			}
		}
	}
	header := q.R.Header.Get("Authorization")
	if header != "" {
		parts := strings.Fields(header)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || len(parts[1]) > 512 {
			return fail("invalid_token", 401)
		}
		hash := security.HashToken(parts[1])
		user, err := s.Store.one(q.ctx(), "users", M{"apiTokens.tokenHash": hash})
		if err != nil {
			return fail("authentication_unavailable", 503)
		}
		token := M{}
		for _, v := range arr(user["apiTokens"]) {
			if str(obj(v)["tokenHash"]) == hash {
				token = obj(v)
				break
			}
		}
		if !identity(user).Active() || len(token) == 0 || !validAPIToken(token) {
			return fail("invalid_token", 401)
		}
		if str(token["scope"]) != "" {
			if !maintenanceAllows(q.R.Method, q.R.URL.Path, stringsOf(token["repoIds"])) {
				return fail("token_scope_forbidden", 403)
			}
			q.Maintenance = true
		}
		q.User = user
		q.Identity = identity(user)
		_, err = s.Store.update(q.ctx(), "users", M{"_id": user["_id"], "apiTokens.tokenHash": hash}, M{"$set": M{"apiTokens.$.lastUsedAt": time.Now()}})
		if err != nil {
			return err
		}
	}

	return nil
}
func (q *request) saveSession(rotate bool) error {
	if q.Session == nil {
		q.Session = M{}
	}
	old := q.SessionID
	if old == "" || rotate {
		token, err := security.RandomToken()
		if err != nil {
			return err
		}
		q.SessionID = token
	}
	ttl := 24 * time.Hour
	if q.Identity.Active() {
		ttl = authenticatedSessionTTL
	}
	q.sessionCookieMetadata(ttl)
	b, err := json.Marshal(q.Session)
	if err != nil {
		return err
	}
	if err = q.Server.Store.Redis.Set(q.ctx(), "anoGH_session:"+q.SessionID, b, ttl).Err(); err != nil {
		return fail("session_unavailable", 503)
	}
	if rotate && old != "" && old != q.SessionID {
		if err = q.Server.Store.Redis.Del(q.ctx(), "anoGH_session:"+old).Err(); err != nil {
			return fail("session_unavailable", 503)
		}
	}
	q.setSessionCookie(ttl)
	return nil
}
func (q *request) login(user M) error {
	q.User = user
	q.Identity = identity(user)
	q.Session["passport"] = M{"user": str(user["_id"])}
	return q.saveSession(true)
}
func (s *Server) logout(q *request) (any, error) {
	if q.SessionID != "" {
		if err := s.Store.Redis.Del(q.ctx(), "anoGH_session:"+q.SessionID).Err(); err != nil {
			return nil, err
		}
	}
	http.SetCookie(q.W, &http.Cookie{Name: "connect.sid", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.Config.SecureCookies, SameSite: http.SameSiteLaxMode})
	return q.redirect("/"), nil
}
func (s *Server) loginToken(q *request) (any, error) {
	token := strings.TrimSpace(str(q.Body["token"]))
	parts := strings.Fields(q.R.Header.Get("Authorization"))
	if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
		token = parts[1]
	}
	if token == "" {
		return nil, fail("missing_token", 400)
	}
	u, err := s.Store.one(q.ctx(), "users", M{"apiTokens.tokenHash": security.HashToken(token)})
	if err != nil {
		return nil, err
	}
	if u == nil {
		return nil, fail("invalid_token", 401)
	}
	if !identity(u).Active() {
		if str(u["status"]) == "banned" {
			return nil, fail("user_banned", 403)
		}
		return nil, fail("not_connected", 401)
	}
	for _, v := range arr(u["apiTokens"]) {
		t := obj(v)
		if str(t["tokenHash"]) == security.HashToken(token) && (str(t["scope"]) != "" || !validAPIToken(t)) {
			return nil, fail("invalid_token", 401)
		}
	}
	if err = q.login(u); err != nil {
		return nil, err
	}
	return M{"ok": true, "username": u["username"]}, nil
}

type authFlow struct {
	State      string    `json:"state"`
	SessionID  string    `json:"sid"`
	OwnerID    string    `json:"ownerId,omitempty"`
	GitHubID   string    `json:"githubId,omitempty"`
	ReturnTo   string    `json:"returnTo"`
	Provider   string    `json:"provider"`
	Expires    time.Time `json:"expires"`
	Install    bool      `json:"install,omitempty"`
	Repository string    `json:"repository,omitempty"`
}

// One pending attempt per browser session and authorization provider. Both
// replacement and consumption are atomic across API instances.
const replaceOAuthFlow = `local old=redis.call('get',KEYS[1]); if old then redis.call('del',ARGV[4]..old) end; redis.call('set',KEYS[2],ARGV[2],'PX',ARGV[3]); redis.call('set',KEYS[1],ARGV[1],'PX',ARGV[3]); return 1`
const consumeOAuthFlow = `local state=redis.call('get',KEYS[1]); if not state then return false end; redis.call('del',KEYS[1]); local key=ARGV[1]..state; local flow=redis.call('get',key); redis.call('del',key); return flow`

func oauthPendingKey(sessionID string, app bool) string {
	provider := "github"
	if app {
		provider = "github-app-user"
	}
	return "go:oauth-pending:" + provider + ":" + sessionID
}

func (s *Server) oauthStart(q *request) (any, error) {
	app := strings.Contains(q.R.URL.Path, "/app/")
	if app && (!s.Config.AppEnabled || !s.Config.AppNewConnections) {
		return nil, fail("github_app_disabled", 503)
	}
	if !app && !s.Config.OAuthEnabled {
		return nil, fail("github_oauth_disabled", 503)
	}
	if err := q.saveSession(false); err != nil {
		return nil, err
	}
	state, err := security.RandomToken()
	if err != nil {
		return nil, err
	}
	query := parseExtendedQuery(q.R.URL.RawQuery).object
	returnTo, _ := query["returnTo"].scalarValue()
	fallback := "/dashboard"
	if app {
		fallback = "/connections"
		if !query["returnTo"].truthy() {
			returnTo = "/dashboard"
			if q.Identity.Active() {
				returnTo = "/connections"
			}
		}
	}
	flow := authFlow{State: state, SessionID: q.SessionID, OwnerID: q.Identity.ID, GitHubID: q.Identity.GitHubID, ReturnTo: security.ReturnTo(returnTo, fallback), Provider: "github", Expires: time.Now().Add(10 * time.Minute)}
	clientID, callback := s.Config.ClientID, s.Config.Callback
	if app {
		clientID, callback = s.Config.AppClientID, s.Config.AppCallback
		flow.Provider = "github-app-user"
		install, _ := query["install"].scalarValue()
		flow.Install = install == "1"
		if repository, ok := query["repository"].scalarValue(); ok && safeRepositoryName(repository) {
			flow.Repository = repository
		}
	}
	b, _ := json.Marshal(flow)
	if err = s.Store.Redis.Eval(q.ctx(), replaceOAuthFlow, []string{oauthPendingKey(q.SessionID, app), "go:oauth:" + state}, state, b, (10 * time.Minute).Milliseconds(), "go:oauth:").Err(); err != nil {
		return nil, err
	}
	values := url.Values{"client_id": {clientID}, "redirect_uri": {callback}, "state": {state}}
	if !app {
		values.Set("scope", "repo")
	}
	return q.redirect("https://github.com/login/oauth/authorize?" + values.Encode()), nil
}
func (s *Server) oauthCallback(q *request) (any, error) {
	app := strings.Contains(q.R.URL.Path, "/app/")
	if app && (!s.Config.AppEnabled || !s.Config.AppNewConnections) {
		return nil, fail("github_app_disabled", 503)
	}
	if !app && !s.Config.OAuthEnabled {
		return nil, fail("github_oauth_disabled", 503)
	}
	query := parseExtendedQuery(q.R.URL.RawQuery).object
	parsedState, scalarState := query["state"].scalarValue()
	if q.SessionID == "" {
		return nil, fail("invalid_auth_state", 400)
	}
	// Consume this browser's pending attempt before checking returned parameters.
	// Missing, malformed and superseded states cannot leave a retryable flow.
	raw, err := s.Store.Redis.Eval(q.ctx(), consumeOAuthFlow, []string{oauthPendingKey(q.SessionID, app)}, "go:oauth:").Text()
	if err != nil {
		return nil, fail("invalid_auth_state", 400)
	}
	var flow authFlow
	if !scalarState || json.Unmarshal([]byte(raw), &flow) != nil || flow.Expires.Before(time.Now()) || flow.SessionID != q.SessionID || subtle.ConstantTimeCompare([]byte(flow.State), []byte(parsedState)) != 1 {
		return nil, fail("invalid_auth_state", 400)
	}
	if flow.OwnerID != q.Identity.ID {
		return nil, fail("github_identity_mismatch", 409)
	}
	if app != (flow.Provider == "github-app-user") {
		return nil, fail("invalid_auth_state", 400)
	}
	code, scalarCode := query["code"].scalarValue()
	if !scalarCode || !app && code == "" || query["error"].truthy() {
		return nil, fail("github_app_authorization_cancelled", 400)
	}
	clientID, secret, callback := s.Config.ClientID, s.Config.ClientSecret, s.Config.Callback
	if app {
		clientID, secret, callback = s.Config.AppClientID, s.Config.AppClientSecret, s.Config.AppCallback
	}
	tokens, err := s.exchange(q.ctx(), M{"client_id": clientID, "client_secret": secret, "code": code, "redirect_uri": callback})
	if err != nil {
		return nil, err
	}
	if app {
		if _, _, err := appTokenLifetimes(tokens); err != nil {
			return nil, err
		}
	}
	profile, err := s.githubObject(q.ctx(), "GET", "/user", str(tokens["access_token"]), nil)
	if err != nil {
		return nil, err
	}
	if app {
		if err := validateAppProfile(profile); err != nil {
			return nil, err
		}
	}
	githubID := str(profile["id"])
	login := str(profile["login"])
	if githubID == "" || login == "" {
		return nil, fail("github_identity_mismatch", 409)
	}
	if flow.GitHubID != "" && flow.GitHubID != githubID {
		return nil, fail("github_identity_mismatch", 409)
	}
	user, err := s.Store.one(q.ctx(), "users", M{"externalIDs.github": githubID})
	if err != nil {
		return nil, err
	}
	if user == nil {
		existing, err := s.Store.one(q.ctx(), "users", M{"username": login})
		if err != nil {
			return nil, err
		}
		if existing != nil {
			return nil, fail("github_identity_mismatch", 409)
		}
		if flow.OwnerID != "" {
			return nil, fail("github_identity_mismatch", 409)
		}
		user = M{"_id": bson.NewObjectID(), "username": login, "externalIDs": M{"github": githubID}, "photo": profile["avatar_url"], "emails": []any{}, "status": "active", "dateOfEntry": time.Now(), "isAdmin": false, "apiTokens": []any{}}
		if _, err = s.Store.DB.Collection("users").InsertOne(q.ctx(), user); err != nil {
			return nil, err
		}
	}
	if !identity(user).Active() {
		return nil, fail("not_connected", 403)
	}
	if flow.OwnerID != "" && flow.OwnerID != str(user["_id"]) {
		return nil, fail("github_identity_mismatch", 409)
	}
	if err = s.saveGrant(q, user["_id"], flow.Provider, tokens); err != nil {
		return nil, err
	}
	s.saveRegistrationEmail(q.ctx(), user, str(tokens["access_token"]))
	if err = s.resetOwnerAlerts(q.ctx(), user["_id"], "", nil); err != nil {
		return nil, err
	}
	if err = q.login(user); err != nil {
		return nil, err
	}
	if app && flow.Install {
		encode := func(value string) string { return strings.ReplaceAll(url.QueryEscape(value), "+", "%20") }
		return q.redirect("/github/app/install?returnTo=" + encode(flow.ReturnTo) + "&repository=" + encode(flow.Repository)), nil
	}
	return q.redirect(flow.ReturnTo), nil
}
func (s *Server) saveGrant(q *request, owner any, provider string, tokens M) error {
	if provider == "github-app-user" {
		if _, _, err := appTokenLifetimes(tokens); err != nil {
			return err
		}
	}
	access, valid := tokens["access_token"].(string)
	if !valid || access == "" {
		return fail("github_app_reconnect_required", 401)
	}
	envelope, err := s.Config.Cipher.Encrypt(access, str(owner), provider, "")
	if err != nil {
		return err
	}
	revision, err := security.RandomToken()
	if err != nil {
		return err
	}
	set := M{"encryptedToken": envelope, "updatedAt": time.Now(), "revoked": false, "reconciliationPending": false, "revision": revision}
	unset := M{"refreshLock": "", "refreshLockUntil": "", "encryptedRefreshToken": "", "expiresAt": "", "refreshExpiresAt": ""}
	if refresh, ok := tokens["refresh_token"].(string); ok && refresh != "" {
		encrypted, err := s.Config.Cipher.Encrypt(refresh, str(owner), provider, "encryptedRefreshToken")
		if err != nil {
			return err
		}
		set["encryptedRefreshToken"] = encrypted
		delete(unset, "encryptedRefreshToken")
	}
	if expires, ok := tokenLifetime(tokens["expires_in"]); ok {
		set["expiresAt"] = time.Now().Add(expires)
		delete(unset, "expiresAt")
	}
	if expires, ok := tokenLifetime(tokens["refresh_token_expires_in"]); ok {
		set["refreshExpiresAt"] = time.Now().Add(expires)
		delete(unset, "refreshExpiresAt")
	}
	_, err = s.Store.DB.Collection("credentials").UpdateOne(q.ctx(), M{"ownerId": owner, "provider": provider}, M{"$set": set, "$unset": unset}, options.UpdateOne().SetUpsert(true))
	if err != nil {
		return err
	}
	_, err = s.Store.update(q.ctx(), "users", M{"_id": owner}, M{"$set": M{"repositories": []any{}}, "$inc": M{"repositoryDiscoveryRevision": 1}})
	return err
}

func validAPIToken(t M) bool {
	expires := date(t["expiresAt"])
	scope := str(t["scope"])
	hasExpiry := t["expiresAt"] != nil
	return (!hasExpiry || expires.After(time.Now())) && (scope == "" || scope == "repository-maintenance" && hasExpiry)
}
func maintenanceAllows(method, path string, ids []string) bool {
	path = strings.TrimSuffix(path, "/")
	for _, id := range ids {
		if (method == "GET" || method == "PATCH") && path == "/api/maintenance/repositories/"+id {
			return true
		}
		if method == "POST" && (path == "/api/repo/"+id+"/refresh" || path == "/api/repo/"+id+"/extend") {
			return true
		}
	}
	return false
}
