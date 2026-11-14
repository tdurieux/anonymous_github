package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
)

func runOAuthCallbackIntegration(t *testing.T, s *Server, token string) {
	t.Run("OAuth callback session and identity", func(t *testing.T) {
		ctx := context.Background()
		oldHTTP, oldConfig := s.HTTP, s.Config
		defer func() { s.HTTP, s.Config = oldHTTP, oldConfig }()
		s.Config.OAuthEnabled = true
		s.Config.AppEnabled = true
		s.Config.AppNewConnections = true
		s.Config.ClientID = "synthetic-client"
		s.Config.ClientSecret = "synthetic-secret"
		s.Config.Callback = "https://anonymous.test/github/auth"
		s.Config.AppClientID = "synthetic-app"
		s.Config.AppClientSecret = "synthetic-app-secret"
		s.Config.AppCallback = "https://anonymous.test/github/app/callback"
		exchanges, profiles := 0, 0
		profileID := float64(7000123)
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			var value M
			switch r.URL.Host + r.URL.Path {
			case "github.com/login/oauth/access_token":
				exchanges++
				value = M{"access_token": "synthetic-callback-access", "refresh_token": "synthetic-callback-refresh", "expires_in": 3600, "refresh_token_expires_in": 7200}
			case "api.github.com/user/emails":
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("[]"))}, nil
			case "api.github.com/user":
				profiles++
				value = M{"id": profileID, "login": "oauth-callback-fixture", "avatar_url": "https://avatar.test/image"}
			default:
				t.Errorf("unexpected OAuth request: %s", r.URL.Host+r.URL.Path)
				return nil, io.ErrUnexpectedEOF
			}
			raw, _ := json.Marshal(value)
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
		})}
		call := func(path string, cookie *http.Cookie, bearer string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("GET", path, nil)
			req.RemoteAddr = "198.51.100.9:1234"
			if cookie != nil {
				req.AddCookie(cookie)
			}
			if bearer != "" {
				req.Header.Set("Authorization", "Bearer "+bearer)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		start := func(path string, cookie *http.Cookie) (string, *http.Cookie) {
			t.Helper()
			w := call(path, cookie, "")
			if w.Code != 302 {
				t.Fatal("login start", w.Code, w.Body)
			}
			redirect, err := url.Parse(w.Header().Get("Location"))
			if err != nil {
				t.Fatal(err)
			}
			state := redirect.Query().Get("state")
			if len(state) != 64 {
				t.Fatal("missing state")
			}
			cookies := w.Result().Cookies()
			if len(cookies) != 1 {
				t.Fatal("missing session cookie")
			}
			return state, cookies[0]
		}
		expect := func(w *httptest.ResponseRecorder, status int, code string) {
			t.Helper()
			var result M
			json.Unmarshal(w.Body.Bytes(), &result)
			if w.Code != status || result["error"] != code {
				t.Fatal(w.Code, w.Body)
			}
		}
		state, cookie := start("/github/login?returnTo=%2Fdashboard%3Ftab%3Downed", nil)
		signed, err := url.QueryUnescape(cookie.Value)
		if err != nil {
			t.Fatal(err)
		}
		oldSID, ok := security.VerifySession(signed, s.Config.SessionSecret)
		if !ok {
			t.Fatal("unsigned session")
		}
		callback := "/github/auth?state=" + state + "&code=synthetic-code"
		success := call(callback, cookie, "")
		if success.Code != 302 || success.Header().Get("Location") != "/dashboard?tab=owned" {
			t.Fatal(success.Code, success.Header())
		}
		cookies := success.Result().Cookies()
		if len(cookies) != 1 || cookies[0].Value == cookie.Value {
			t.Fatal("session was not rotated")
		}
		authenticated := cookies[0]
		if count, err := s.Store.Redis.Exists(ctx, "anoGH_session:"+oldSID, "go:oauth:"+state).Result(); err != nil || count != 0 {
			t.Fatal("old state/session survived", count, err)
		}
		if w := call("/api/user", authenticated, ""); w.Code != 200 {
			t.Fatal("new session not authenticated", w.Code, w.Body)
		}

		t.Run("persistent rolling session", func(t *testing.T) {
			if authenticated.MaxAge != int(authenticatedSessionTTL.Seconds()) || authenticated.Expires.Before(time.Now().Add(29*24*time.Hour)) || !authenticated.HttpOnly || authenticated.SameSite != http.SameSiteLaxMode {
				t.Fatal("login cookie is not persistent and protected")
			}
			signed, _ := url.QueryUnescape(authenticated.Value)
			sid, _ := security.VerifySession(signed, s.Config.SessionSecret)
			key := "anoGH_session:" + sid
			raw, err := s.Store.Redis.Get(ctx, key).Bytes()
			if err != nil {
				t.Fatal(err)
			}
			var session M
			if err := json.Unmarshal(raw, &session); err != nil {
				t.Fatal(err)
			}
			// Simulate an old session, including sessions issued before this fix.
			session["cookie"] = M{"expires": nil}
			aged, _ := json.Marshal(session)
			if err := s.Store.Redis.Set(ctx, key, aged, time.Hour).Err(); err != nil {
				t.Fatal(err)
			}
			w := call("/api/user", authenticated, "")
			if w.Code != 200 || len(w.Result().Cookies()) != 1 || w.Result().Cookies()[0].MaxAge != authenticated.MaxAge {
				t.Fatal("old session was not upgraded", w.Code)
			}
			if ttl := s.Store.Redis.TTL(ctx, key).Val(); ttl < authenticatedSessionTTL-time.Minute {
				t.Fatal("session TTL not renewed", ttl)
			}
			w = call("/api/user", authenticated, "")
			if w.Code != 200 || len(w.Result().Cookies()) != 0 {
				t.Fatal("session renewed more than once a day")
			}

			session["cookie"] = M{"expires": time.Now().Add(28 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)}
			aged, _ = json.Marshal(session)
			if err := s.Store.Redis.Set(ctx, key, aged, 28*24*time.Hour).Err(); err != nil {
				t.Fatal(err)
			}
			w = call("/api/user", authenticated, "")
			if w.Code != 200 || len(w.Result().Cookies()) != 1 || s.Store.Redis.TTL(ctx, key).Val() < authenticatedSessionTTL-time.Minute {
				t.Fatal("daily renewal failed")
			}
			// A stale renewal must not overwrite a newer session or recreate a revoked one.
			updated := s.Store.Redis.Get(ctx, key).Val()
			if n, err := s.Store.Redis.Eval(ctx, renewSession, []string{key}, aged, aged, authenticatedSessionTTL.Milliseconds()).Int(); err != nil || n != 0 {
				t.Fatal("stale renewal accepted", n, err)
			}
			if s.Store.Redis.Get(ctx, key).Val() != updated {
				t.Fatal("session overwritten")
			}
			revokedKey := key + ":revoked-test"
			if n, err := s.Store.Redis.Eval(ctx, renewSession, []string{revokedKey}, aged, aged, authenticatedSessionTTL.Milliseconds()).Int(); err != nil || n != 0 {
				t.Fatal("revoked session recreated", n, err)
			}
			if s.Store.Redis.Exists(ctx, revokedKey).Val() != 0 {
				t.Fatal("revoked session exists")
			}
		})
		expect(call(callback, cookie, ""), 400, "invalid_auth_state")
		if exchanges != 1 || profiles != 1 {
			t.Fatal("replay reached upstream", exchanges, profiles)
		}
		// A second anonymous browser must find the existing immutable identity,
		// including GitHub IDs large enough for fmt's scientific notation.
		repeatState, repeatCookie := start("/github/login", nil)
		if w := call("/github/auth?state="+repeatState+"&code=synthetic-code", repeatCookie, ""); w.Code != 302 {
			t.Fatal("existing identity login", w.Code, w.Body)
		}
		baselineExchanges, baselineProfiles := exchanges, profiles
		for _, mode := range []string{"app", "new-connections", "legacy"} {
			loginPath, callbackPath, expected := "/github/app/login", "/github/app/callback", "github_app_disabled"
			if mode == "legacy" {
				loginPath, callbackPath, expected = "/github/login", "/github/auth", "github_oauth_disabled"
			}
			pending, pendingCookie := start(loginPath, nil)
			switch mode {
			case "app":
				s.Config.AppEnabled = false
			case "new-connections":
				s.Config.AppNewConnections = false
			case "legacy":
				s.Config.OAuthEnabled = false
			}
			expect(call(callbackPath+"?state="+pending+"&code=synthetic-code", pendingCookie, ""), 503, expected)
			expect(call(callbackPath, nil, ""), 503, expected)
			if n := s.Store.Redis.Exists(ctx, "go:oauth:"+pending).Val(); n != 1 {
				t.Fatal("disabled callback consumed pending flow", mode)
			}
			s.Config.AppEnabled, s.Config.AppNewConnections, s.Config.OAuthEnabled = true, true, true
			expect(call(callbackPath+"?state="+pending+"&error=cancelled", pendingCookie, ""), 400, "github_app_authorization_cancelled")
			expect(call(callbackPath+"?state="+pending+"&code=synthetic-code", pendingCookie, ""), 400, "invalid_auth_state")
		}

		// An unrelated browser consumes only its own flow; it cannot destroy
		// the rightful browser's pending authorization.
		state, cookie = start("/github/login", nil)
		_, otherCookie := start("/github/login", nil)
		callback = "/github/auth?state=" + state + "&code=synthetic-code"
		expect(call(callback, otherCookie, ""), 400, "invalid_auth_state")
		if n := s.Store.Redis.Exists(ctx, "go:oauth:"+state).Val(); n != 1 {
			t.Fatal("foreign session consumed owner flow")
		}
		expect(call(callback+"&error=cancelled", cookie, ""), 400, "github_app_authorization_cancelled")

		expect(call(callback, cookie, ""), 400, "invalid_auth_state")
		// A later start supersedes the previous attempt in the same browser.
		first, flowCookie := start("/github/app/login", nil)
		second, flowCookie := start("/github/app/login", flowCookie)
		if n := s.Store.Redis.Exists(ctx, "go:oauth:"+first).Val(); n != 0 {
			t.Fatal("superseded flow retained")
		}
		expect(call("/github/app/callback?state="+first+"&code=synthetic-code", flowCookie, ""), 400, "invalid_auth_state")
		expect(call("/github/app/callback?state="+second+"&code=synthetic-code", flowCookie, ""), 400, "invalid_auth_state")
		for _, malformed := range []string{"", "state=", "state=wrong", "state[]=", "state[x]=wrong"} {
			pending, pendingCookie := start("/github/app/login", nil)
			expect(call("/github/app/callback?"+malformed+"&code=synthetic-code", pendingCookie, ""), 400, "invalid_auth_state")
			if n := s.Store.Redis.Exists(ctx, "go:oauth:"+pending).Val(); n != 0 {
				t.Fatal("malformed callback retained pending flow", malformed)
			}
			expect(call("/github/app/callback?state="+pending+"&code=synthetic-code", pendingCookie, ""), 400, "invalid_auth_state")
		}
		// Concurrent callbacks can consume the pending attempt only once.
		concurrentState, concurrentCookie := start("/github/app/login", nil)
		signedConcurrent, err := url.QueryUnescape(concurrentCookie.Value)
		if err != nil {
			t.Fatal(err)
		}
		concurrentSID, ok := security.VerifySession(signedConcurrent, s.Config.SessionSecret)
		if !ok {
			t.Fatal("unsigned concurrent session")
		}
		results := make(chan error, 16)
		for i := 0; i < 16; i++ {
			go func() {
				q := &request{Server: s, SessionID: concurrentSID, R: httptest.NewRequest("GET", "/github/app/callback?state="+concurrentState+"&error=cancelled", nil)}
				_, err := s.oauthCallback(q)
				results <- err
			}()
		}
		consumed := 0
		for i := 0; i < 16; i++ {
			err := <-results
			if err == nil {
				t.Fatal("concurrent callback succeeded")
			}
			switch err.Error() {
			case "github_app_authorization_cancelled":
				consumed++
			case "invalid_auth_state":
			default:
				t.Fatal(err)
			}
		}
		if consumed != 1 {
			t.Fatal("pending flow not atomically consumed", consumed)
		}
		// App and legacy OAuth have separate pending flows in the same browser.
		legacyState, sharedCookie := start("/github/login", nil)
		appState, sharedCookie := start("/github/app/login", sharedCookie)
		expect(call("/github/auth?state="+legacyState+"&error=cancelled", sharedCookie, ""), 400, "github_app_authorization_cancelled")
		expect(call("/github/app/callback?state="+appState+"&error=cancelled", sharedCookie, ""), 400, "github_app_authorization_cancelled")
		// A changed authenticated identity must not turn an anonymous login into
		// an account switch, even if its original browser session still exists.
		state, cookie = start("/github/login", nil)
		expect(call("/github/auth?state="+state+"&code=synthetic-code", cookie, token), 409, "github_identity_mismatch")
		state, cookie = start("/github/login", nil)
		raw, err := s.Store.Redis.Get(ctx, "go:oauth:"+state).Bytes()
		if err != nil {
			t.Fatal(err)
		}
		var flow authFlow
		if err := json.Unmarshal(raw, &flow); err != nil {
			t.Fatal(err)
		}
		flow.Expires = time.Now().Add(-time.Minute)
		raw, _ = json.Marshal(flow)
		if err := s.Store.Redis.Set(ctx, "go:oauth:"+state, raw, time.Minute).Err(); err != nil {
			t.Fatal(err)
		}
		expect(call("/github/auth?state="+state+"&code=synthetic-code", cookie, ""), 400, "invalid_auth_state")
		state, cookie = start("/github/login", nil)
		expect(call("/github/auth?state="+state+"&error=access_denied", cookie, ""), 400, "github_app_authorization_cancelled")
		state, cookie = start("/github/login", nil)
		expect(call("/github/app/callback?state="+state+"&code=synthetic-code", cookie, ""), 400, "invalid_auth_state")
		if exchanges != baselineExchanges || profiles != baselineProfiles {
			t.Fatal("invalid flow reached upstream", exchanges, profiles)
		}
		// A signed-in owner must reconnect the same upstream identity.
		state, cookie = start("/github/app/login", authenticated)
		profileID = 7000999
		expect(call("/github/app/callback?state="+state+"&code=synthetic-code", cookie, ""), 409, "github_identity_mismatch")
		user, err := s.Store.one(ctx, "users", M{"externalIDs.github": "7000123"})
		if err != nil || user == nil {
			t.Fatal(err)
		}
		grant, err := s.Store.one(ctx, "credentials", M{"ownerId": user["_id"], "provider": "github-app-user"})
		if err != nil || grant != nil {
			t.Fatal("mismatched identity stored a grant", err)
		}
		state, cookie = start("/github/login", nil)
		expect(call("/github/auth?state="+state+"&code=synthetic-code", cookie, ""), 409, "github_identity_mismatch")
		count, err := s.Store.DB.Collection("users").CountDocuments(ctx, M{"username": "oauth-callback-fixture"})
		if err != nil || count != 1 {
			t.Fatal("username-only identity linked or duplicated", count, err)
		}

	})
}
