package server

import (
	"crypto/subtle"
	"regexp"
	"strings"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
)

var mailboxPattern = regexp.MustCompile("^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\\.[a-zA-Z]{2,}$")

func normalizeNotificationEmail(value any) string {
	email, ok := value.(string)
	if !ok {
		return ""
	}
	email = strings.TrimSpace(email)
	if len(email) > 254 || !mailboxPattern.MatchString(email) || strings.Contains(email, "..") {
		return ""
	}
	local := strings.SplitN(email, "@", 2)[0]
	if len(local) > 64 || strings.HasPrefix(local, ".") || strings.HasSuffix(local, ".") {
		return ""
	}
	return email
}
func accountNotificationEmail(user M) string {
	if email := normalizeNotificationEmail(user["notificationEmail"]); email != "" {
		return email
	}
	for _, entry := range arr(user["emails"]) {
		if boolean(obj(entry)["default"]) {
			if email := normalizeNotificationEmail(obj(entry)["email"]); email != "" {
				return email
			}
		}
	}
	for _, entry := range arr(user["emails"]) {
		if email := normalizeNotificationEmail(obj(entry)["email"]); email != "" {
			return email
		}
	}
	return ""
}
func (q *request) connectionCSRF() error {
	if str(q.Session["githubConnectionCSRF"]) == "" {
		token, err := security.RandomToken()
		if err != nil {
			return err
		}
		q.Session["githubConnectionCSRF"] = token
	}
	return q.saveSession(false)
}
func (s *Server) accountProfile(q *request) (any, error) {
	result := userProfile(q.User)
	enabled := s.Config.EmailAPIKey != "" && s.Config.EmailFrom != ""
	show := enabled && accountNotificationEmail(q.User) == "" && !boolean(q.User["emailPromptNever"]) && !boolean(q.Session["emailPromptDismissed"])
	result["showEmailPrompt"], result["notificationEmail"], result["emailNotificationsEnabled"] = show, accountNotificationEmail(q.User), enabled
	if show {
		if err := q.connectionCSRF(); err != nil {
			return nil, err
		}
		result["emailPromptCSRF"] = q.Session["githubConnectionCSRF"]
	}
	q.W.Header().Set("Cache-Control", "no-store")
	return result, nil
}
func (s *Server) accountEmail(q *request) (any, error) {
	q.W.Header().Set("Cache-Control", "no-store")
	if q.R.Method == "GET" {
		if err := q.connectionCSRF(); err != nil {
			return nil, err
		}
		return M{"csrf": q.Session["githubConnectionCSRF"], "notificationEmail": accountNotificationEmail(q.User)}, nil
	}
	csrf := str(q.Session["githubConnectionCSRF"])
	if csrf == "" || subtle.ConstantTimeCompare([]byte(csrf), []byte(q.R.Header.Get("X-CSRF-Token"))) != 1 {
		return nil, fail("invalid_auth_state", 403)
	}
	action := str(q.Body["action"])
	if action == "" {
		action = "save"
	}
	if action == "later" || action == "never" {
		if action == "never" {
			if _, err := s.Store.update(q.ctx(), "users", M{"_id": q.User["_id"]}, M{"$set": M{"emailPromptNever": true}}); err != nil {
				return nil, err
			}
		}
		q.Session["emailPromptDismissed"] = true
		if err := q.saveSession(false); err != nil {
			return nil, err
		}
		return M{"ok": true}, nil
	}
	if action != "save" {
		return nil, fail("Invalid email preference.", 400)
	}
	email := normalizeNotificationEmail(q.Body["email"])
	if email == "" {
		return nil, fail("Enter a valid email address.", 400)
	}
	_, err := s.Store.update(q.ctx(), "users", M{"_id": q.User["_id"]}, M{"$set": M{"notificationEmail": email}})
	return M{"notificationEmail": email}, err
}
