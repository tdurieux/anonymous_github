package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
)

const authenticatedSessionTTL = 30 * 24 * time.Hour

func (q *request) sessionCookieMetadata(ttl time.Duration) {
	cookie := M{"originalMaxAge": nil, "expires": nil, "secure": q.Server.Config.SecureCookies, "httpOnly": true, "path": "/", "sameSite": "lax"}
	if q.Identity.Active() {
		cookie["originalMaxAge"] = ttl.Milliseconds()
		cookie["expires"] = time.Now().Add(ttl).UTC().Format(time.RFC3339Nano)
	}
	q.Session["cookie"] = cookie
}

func (q *request) setSessionCookie(ttl time.Duration) {
	cookie := &http.Cookie{Name: "connect.sid", Value: url.QueryEscape(security.SignSession(q.SessionID, q.Server.Config.SessionSecret)), Path: "/", HttpOnly: true, Secure: q.Server.Config.SecureCookies, SameSite: http.SameSiteLaxMode}
	if q.Identity.Active() {
		cookie.MaxAge = int(ttl.Seconds())
		cookie.Expires = time.Now().Add(ttl).UTC()
	}
	http.SetCookie(q.W, cookie)
}

// Refresh at most once per day. Compare-and-set prevents an in-flight request
// from recreating a session deleted by logout or overwriting a concurrent save.
const renewSession = `if redis.call('get',KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('set',KEYS[1],ARGV[2],'PX',ARGV[3]); return 1`

func (q *request) refreshSession(raw []byte) error {
	expires, err := time.Parse(time.RFC3339Nano, str(obj(q.Session["cookie"])["expires"]))
	if err == nil && time.Until(expires) > authenticatedSessionTTL-24*time.Hour {
		return nil
	}
	q.sessionCookieMetadata(authenticatedSessionTTL)
	updated, err := json.Marshal(q.Session)
	if err != nil {
		return err
	}
	renewed, err := q.Server.Store.Redis.Eval(q.ctx(), renewSession, []string{"anoGH_session:" + q.SessionID}, raw, updated, authenticatedSessionTTL.Milliseconds()).Int()
	if err != nil {
		return fail("session_unavailable", 503)
	}
	if renewed == 1 {
		q.setSessionCookie(authenticatedSessionTTL)
	}
	return nil
}
