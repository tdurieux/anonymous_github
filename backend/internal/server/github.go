package server

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func (s *Server) github(ctx context.Context, method, path, token string, body any) (any, error) {
	result, _, err := s.githubResponse(ctx, method, path, token, body, false)
	return result, err
}

// Keep the upstream status for adapter decisions without changing public errors.
type githubHTTPError struct {
	status int
	err    error
}

func (e *githubHTTPError) Error() string { return e.err.Error() }
func (e *githubHTTPError) Unwrap() error { return e.err }

func (s *Server) githubResponse(ctx context.Context, method, path, token string, body any, emptyConflict bool) (any, http.Header, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\\r\n") {
		return nil, nil, fail("invalid_github_path", 400)
	}
	var reader io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return nil, nil, e
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://api.github.com"+path, reader)
	if err != nil {
		return nil, nil, fail("github_unavailable", 502)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "Anonymous-GitHub")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if err := s.checkGitHubQuota(ctx, token); err != nil {
		return nil, nil, err
	}
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return nil, nil, fail("github_unavailable", 502)
	}
	defer resp.Body.Close()
	if githubLimited(resp) {
		return nil, nil, &githubHTTPError{status: resp.StatusCode, err: s.recordGitHubQuota(ctx, token, resp.Header)}
	}
	if resp.StatusCode >= 500 {
		return nil, nil, &githubHTTPError{status: resp.StatusCode, err: fail("github_unavailable", 502)}
	}
	if resp.StatusCode == 401 {
		return nil, nil, &githubHTTPError{status: resp.StatusCode, err: fail("github_app_reconnect_required", 403)}
	}
	if emptyConflict && resp.StatusCode == 409 {
		return []any{}, http.Header{}, nil
	}
	if resp.StatusCode >= 300 {
		return nil, nil, &githubHTTPError{status: resp.StatusCode, err: fail("github_app_access_required", 403)}
	}
	if resp.StatusCode == 204 {
		return nil, nil, nil
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 32*1024*1024+1))
	if err != nil || len(b) > 32*1024*1024 {
		return nil, nil, fail("github_response_too_large", 502)
	}
	var result any
	if json.Unmarshal(b, &result) != nil {
		return nil, nil, fail("github_invalid_response", 502)
	}
	return result, resp.Header, nil
}
func (s *Server) githubObject(ctx context.Context, method, path, token string, body any) (M, error) {
	r, e := s.github(ctx, method, path, token, body)
	if e != nil {
		return nil, e
	}
	return obj(r), nil
}
func (s *Server) exchange(ctx context.Context, values M) (M, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	b, _ := json.Marshal(values)
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://github.com/login/oauth/access_token", bytes.NewReader(b))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return nil, fail("github_unavailable", 502)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return nil, fail("github_unavailable", 502)
	}
	if resp.StatusCode == 429 {
		return nil, githubRateLimit(resp.Header, time.Now())
	}
	var tokens M
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, 65537))
	if readErr != nil || len(data) > 65536 || json.Unmarshal(data, &tokens) != nil || resp.StatusCode >= 300 {
		return nil, fail("github_app_reconnect_required", 401)
	}
	if token, ok := tokens["access_token"].(string); !ok || token == "" {
		return nil, fail("github_app_reconnect_required", 401)
	}
	return tokens, nil
}
func envelope(v any) (security.Envelope, error) {
	var e security.Envelope
	b, err := bson.Marshal(v)
	if err != nil {
		return e, err
	}
	err = bson.Unmarshal(b, &e)
	return e, err
}
func (s *Server) credential(ctx context.Context, owner any, provider string) (string, error) {
	return s.credentialForReconciliation(ctx, owner, provider, false)
}
func (s *Server) credentialForReconciliation(ctx context.Context, owner any, provider string, reconcile bool) (result string, resultErr error) {
	defer func() {
		if resultErr == nil && provider == "github-app-user" {
			s.registerGitHubQuota(result, "app-user:"+str(owner))
		}
	}()

	if provider == "github-app-user" && !s.Config.AppEnabled {
		return "", fail("github_app_disabled", 503)
	}
	user, err := s.Store.one(ctx, "users", M{"_id": owner})
	if err != nil {
		return "", err
	}
	if !identity(user).Active() {
		return "", fail("not_connected", 403)
	}
	for attempt := 0; attempt < 30; attempt++ {
		row, err := s.Store.one(ctx, "credentials", M{"ownerId": owner, "provider": provider})
		if err != nil {
			return "", err
		}
		if row == nil || boolean(row["revoked"]) {
			return "", fail("github_app_reconnect_required", 403)
		}
		if boolean(row["reconciliationPending"]) && !reconcile {
			return "", fail("github_app_reconciliation_pending", 503)
		}
		e, err := envelope(row["encryptedToken"])
		if err != nil {
			return "", fail("credential_decryption_failed", 500)
		}
		if provider != "github-app-user" || date(row["expiresAt"]).After(time.Now().Add(time.Minute)) {
			token, err := s.Config.Cipher.Decrypt(e, str(owner), provider, "")
			if err != nil {
				return "", fail("credential_decryption_failed", 500)
			}
			return token, nil
		}
		if !date(row["refreshExpiresAt"]).After(time.Now()) {
			return "", fail("github_app_reconnect_required", 403)
		}
		lock, err := security.RandomToken()
		if err != nil {
			return "", err
		}
		acquired, err := s.Store.update(ctx, "credentials", M{"_id": row["_id"], "revision": row["revision"], "revoked": M{"$ne": true}, "$or": []M{{"refreshLockUntil": M{"$exists": false}}, {"refreshLockUntil": M{"$lt": time.Now()}}}}, M{"$set": M{"refreshLock": lock, "refreshLockUntil": time.Now().Add(30 * time.Second)}})
		if err != nil {
			return "", err
		}
		if !acquired {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(time.Second):
				continue
			}
		}
		token, err := func() (string, error) {
			defer func() {
				cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				defer stop()
				s.Store.update(cleanup, "credentials", M{"_id": row["_id"], "refreshLock": lock}, M{"$unset": M{"refreshLock": "", "refreshLockUntil": ""}})
			}()
			e, err := envelope(row["encryptedRefreshToken"])
			if err != nil {
				return "", fail("credential_decryption_failed", 500)
			}
			refresh, err := s.Config.Cipher.Decrypt(e, str(owner), provider, "encryptedRefreshToken")
			if err != nil {
				return "", fail("credential_decryption_failed", 500)
			}
			data, err := s.exchange(ctx, M{"client_id": s.Config.AppClientID, "client_secret": s.Config.AppClientSecret, "grant_type": "refresh_token", "refresh_token": refresh})
			if err != nil {
				return "", err
			}
			accessTTL, refreshTTL, err := appTokenLifetimes(data)
			if err != nil {
				return "", err
			}
			access, err := s.Config.Cipher.Encrypt(str(data["access_token"]), str(owner), provider, "")
			if err != nil {
				return "", err
			}
			renew, err := s.Config.Cipher.Encrypt(str(data["refresh_token"]), str(owner), provider, "encryptedRefreshToken")
			if err != nil {
				return "", err
			}
			revision, err := security.RandomToken()
			if err != nil {
				return "", err
			}
			saved, err := s.Store.update(ctx, "credentials", M{"_id": row["_id"], "revision": row["revision"], "refreshLock": lock, "revoked": M{"$ne": true}}, M{"$set": M{"encryptedToken": access, "encryptedRefreshToken": renew, "expiresAt": time.Now().Add(accessTTL), "refreshExpiresAt": time.Now().Add(refreshTTL), "revision": revision, "updatedAt": time.Now()}, "$unset": M{"refreshLock": "", "refreshLockUntil": ""}})
			if err != nil {
				return "", err
			}
			if !saved {
				return "", nil
			}
			return str(data["access_token"]), nil
		}()
		if err != nil {
			return "", err
		}
		if token != "" {
			return token, nil
		}
	}
	return "", fail("github_app_refresh_busy", 503)
}
func (s *Server) appJWT() (string, error) {
	if !s.Config.AppEnabled {
		return "", fail("github_app_disabled", 503)
	}
	block, _ := pem.Decode([]byte(s.Config.AppPrivateKey))
	if block == nil {
		return "", errors.New("invalid_app_private_key")
	}
	var key *rsa.PrivateKey
	if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		key = k
	} else {
		k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return "", errors.New("invalid_app_private_key")
		}
		var ok bool
		key, ok = k.(*rsa.PrivateKey)
		if !ok {
			return "", errors.New("invalid_app_private_key")
		}
	}
	encode := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	now := time.Now().Unix()
	payload := encode(M{"alg": "RS256", "typ": "JWT"}) + "." + encode(M{"iat": now - 60, "exp": now + 540, "iss": s.Config.AppClientID})
	hash := sha256.Sum256([]byte(payload))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
	if err != nil {
		return "", errors.New("app_signing_failed")
	}
	token := payload + "." + base64.RawURLEncoding.EncodeToString(sig)
	s.registerGitHubQuota(token, "app:"+s.Config.AppID+":"+s.Config.AppClientID)
	return token, nil
}
func (s *Server) boundToken(ctx context.Context, owner any, binding M, name string) (string, error) {
	if str(binding["kind"]) != "github-app" {
		return s.credential(ctx, owner, "github")
	}
	userToken, err := s.credential(ctx, owner, "github-app-user")
	if err != nil {
		return "", err
	}
	repositoryID := number(binding["repositoryId"])
	if !storedSafeInteger(binding["repositoryId"]) {
		return "", fail("github_app_reconnect_required", 403)
	}
	if boolean(binding["publicRead"]) {
		_, hasInstallation := binding["installationId"]
		if hasInstallation || !safeRepositoryName(name) {
			return "", fail("github_app_access_required", 403)
		}
		err := s.cachedPermission([]string{s.Config.AppID, str(owner), userToken, "public", str(repositoryID), name, str(binding["revision"])}, func() error {
			r, err := s.githubObject(ctx, "GET", "/repos/"+name, userToken, nil)
			if err != nil {
				return err
			}
			if !jsonSafeInteger(r["id"]) || number(r["id"]) != repositoryID || r["private"] != false || str(r["visibility"]) != "public" {
				return fail("github_app_access_required", 403)
			}
			return nil
		})
		if err != nil {
			return "", err
		}
		return userToken, nil
	}
	installationID := number(binding["installationId"])
	if !storedSafeInteger(binding["installationId"]) {
		return "", fail("github_app_reconnect_required", 403)
	}

	local, err := s.Store.one(ctx, "githubinstallations", M{"appId": s.Config.AppID, "installationId": installationID})
	if err != nil {
		return "", err
	}
	if boolean(local["reconciliationPending"]) && str(local["revision"]) != "" {
		jwt, err := s.appJWT()
		if err != nil {
			return "", err
		}
		if err = s.reconcileInstallation(ctx, installationID, str(local["revision"]), jwt); err != nil {
			return "", err
		}
		local, err = s.Store.one(ctx, "githubinstallations", M{"appId": s.Config.AppID, "installationId": installationID})
		if err != nil {
			return "", err
		}
	}
	if boolean(local["blocked"]) {
		return "", fail("github_app_access_required", 403)
	}

	if err := s.cachedPermission([]string{s.Config.AppID, str(owner), userToken, "installation", str(installationID), str(repositoryID), str(local["revision"]), str(binding["revision"])}, func() error {
		_, err := s.githubObject(ctx, "GET", fmt.Sprintf("/repositories/%d", repositoryID), userToken, nil)
		return err
	}); err != nil {
		return "", err
	}

	cacheKey := fmt.Sprintf("%s:%d:%d:%s", str(owner), installationID, repositoryID, str(local["revision"]))
	value, err, _ := s.tokenFlights.Do(cacheKey, func() (any, error) {
		s.tokenMu.Lock()
		cached, found := s.appTokens[cacheKey]
		s.tokenMu.Unlock()
		if found && cached.expires.After(time.Now().Add(time.Minute)) {
			return cached.token, nil
		}
		jwt, err := s.appJWT()
		if err != nil {
			return nil, err
		}
		installation, err := s.githubObject(ctx, "GET", fmt.Sprintf("/app/installations/%d", installationID), jwt, nil)
		if err != nil {
			return nil, err
		}
		permissions := obj(installation["permissions"])
		if str(installation["app_id"]) != s.Config.AppID || inputTruthy(installation["suspended_at"]) || str(permissions["contents"]) != "read" {
			return nil, fail("github_app_access_required", 403)
		}
		for _, v := range permissions {
			if v == "write" || v == "admin" {
				return nil, fail("github_app_permissions_invalid", 403)
			}
		}
		scopes := M{"contents": "read", "metadata": "read"}
		for _, k := range []string{"pull_requests", "pages"} {
			if permissions[k] == "read" {
				scopes[k] = "read"
			}
		}
		issued, err := s.githubObject(ctx, "POST", fmt.Sprintf("/app/installations/%d/access_tokens", installationID), jwt, M{"repository_ids": []int64{repositoryID}, "permissions": scopes})
		if err != nil {
			return nil, err
		}
		token, validToken := issued["token"].(string)
		expiry, validExpiry := issued["expires_at"].(string)
		expires, parsedExpiry := dashboardCursorDate(expiry)
		if !validToken || token == "" || !validExpiry || !parsedExpiry {
			return nil, fail("github_app_reconnect_required", 403)
		}
		current, err := s.Store.one(ctx, "githubinstallations", M{"appId": s.Config.AppID, "installationId": installationID})
		if err != nil {
			return nil, err
		}
		if boolean(current["blocked"]) || str(current["revision"]) != str(local["revision"]) {
			return nil, fail("github_app_access_required", 403)
		}
		if expires.After(time.Now().Add(time.Minute)) {
			s.tokenMu.Lock()
			if s.appTokens == nil || len(s.appTokens) >= 1000 {
				s.appTokens = map[string]installationToken{}
			}
			s.appTokens[cacheKey] = installationToken{token, expires}
			s.tokenMu.Unlock()
		}
		return token, nil
	})
	if err != nil {
		return "", err
	}
	s.registerGitHubQuota(value.(string), "installation:"+s.Config.AppID+":"+str(installationID))
	return value.(string), nil
}
func (s *Server) userToken(ctx context.Context, owner any) (string, error) {
	row, err := s.Store.one(ctx, "credentials", M{"ownerId": owner, "provider": "github"})
	if err != nil {
		return "", err
	}
	if row != nil {
		return s.credential(ctx, owner, "github")
	}
	return s.credential(ctx, owner, "github-app-user")
}
func (s *Server) installations(ctx context.Context, owner any) ([]M, error) {
	token, err := s.credential(ctx, owner, "github-app-user")
	if err != nil {
		return nil, err
	}
	out := []M{}
	err = s.githubPages(ctx, "/user/installations", token, "installations", func(item M) bool {
		if str(item["app_id"]) == s.Config.AppID {
			out = append(out, item)
		}
		return false
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
func (s *Server) selectAccess(ctx context.Context, owner any, name, choice string) (string, M, error) {
	token, binding, _, err := s.selectAccessIdentity(ctx, owner, name, choice, "")
	return token, binding, err
}
func (s *Server) selectAccessIdentity(ctx context.Context, owner any, name, choice, repositoryID string) (string, M, string, error) {
	if !safeRepositoryName(name) {
		return "", nil, "", fail("repo_not_found", 400)
	}
	if choice != "" && choice != "oauth" && choice != "github-app" {
		return "", nil, "", fail("invalid_connection", 400)
	}
	if choice == "" && s.Config.AppEnabled {
		row, err := s.Store.one(ctx, "credentials", M{"ownerId": owner, "provider": "github-app-user"})
		if err != nil {
			return "", nil, "", err
		}
		if row != nil {
			choice = "github-app"
		}
	}
	revision, err := security.RandomToken()
	if err != nil {
		return "", nil, "", err
	}
	if choice != "github-app" {
		token, err := s.storedGrantToken(ctx, owner, "github")
		if err == nil && token == "" {
			err = fail("github_oauth_required", 403)
		}
		return token, M{"kind": "oauth", "revision": revision}, "", err
	}
	token, err := s.credential(ctx, owner, "github-app-user")
	if err != nil {
		return "", nil, "", err
	}
	installations, err := s.installations(ctx, owner)
	if err != nil {
		return "", nil, "", err
	}
	for _, installation := range installations {
		if inputTruthy(installation["suspended_at"]) {
			continue
		}
		var selected M
		err := s.githubPages(ctx, fmt.Sprintf("/user/installations/%d/repositories", number(installation["id"])), token, "repositories", func(repo M) bool {
			if (repositoryID == "" && strings.EqualFold(str(repo["full_name"]), name)) || (repositoryID != "" && str(repo["id"]) == repositoryID) {
				selected = repo
				return true
			}
			return false
		})
		if err != nil {
			return "", nil, "", err
		}
		if selected != nil {
			binding := M{"kind": "github-app", "repositoryId": selected["id"], "installationId": installation["id"], "revision": revision}
			token, err := s.boundToken(ctx, owner, binding, str(selected["full_name"]))
			return token, binding, str(selected["full_name"]), err
		}
	}
	endpoint := "/repos/" + name
	if repositoryID != "" {
		endpoint = "/repositories/" + segment(repositoryID)
	}
	repo, err := s.githubObject(ctx, "GET", endpoint, token, nil)
	if err != nil {
		return "", nil, "", err
	}
	if repo["private"] != false || str(repo["visibility"]) != "public" || !jsonSafeInteger(repo["id"]) {
		return "", nil, "", fail("github_app_access_required", 403)
	}
	binding := M{"kind": "github-app", "publicRead": true, "repositoryId": repo["id"], "revision": revision}
	token, err = s.boundToken(ctx, owner, binding, str(repo["full_name"]))
	return token, binding, str(repo["full_name"]), err
}
func segment(s string) string { return url.PathEscape(s) }

// Raw GitHub responses are restricted to GitHub's API and gist-content host.
// Redirects are revalidated and credentials never follow a cross-host redirect.
func (s *Server) githubText(ctx context.Context, target, token, accept string, limit int64) (string, error) {
	u, e := url.Parse(target)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || (u.Host != "api.github.com" && u.Host != "gist.githubusercontent.com") {
		return "", fail("invalid_github_url", 400)
	}
	req, e := http.NewRequestWithContext(ctx, "GET", target, nil)
	if e != nil {
		return "", e
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "Anonymous-GitHub")
	if u.Host == "api.github.com" && token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := *s.HTTP
	client.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 || r.URL.Scheme != "https" || r.URL.User != nil || r.URL.Port() != "" || (r.URL.Host != "api.github.com" && r.URL.Host != "gist.githubusercontent.com") {
			return errors.New("unsafe_redirect")
		}
		if r.URL.Host != u.Host {
			r.Header.Del("Authorization")
		}
		return nil
	}
	resp, e := client.Do(req)
	if e != nil {
		return "", fail("github_unavailable", 502)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fail("github_content_unavailable", 502)
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if e != nil || int64(len(b)) > limit {
		return "", fail("github_response_too_large", 502)
	}
	return string(b), nil
}

type installationToken struct {
	token   string
	expires time.Time
}
