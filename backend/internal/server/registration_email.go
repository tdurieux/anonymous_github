package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// Missing email permissions and provider outages must not prevent login.
func (s *Server) saveRegistrationEmail(ctx context.Context, user M, token string) {
	if accountNotificationEmail(user) != "" {
		return
	}
	work, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(work, "GET", "https://api.github.com/user/emails?per_page=100", nil)
	if err != nil {
		return
	}
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Accept", "application/vnd.github+json")
	r.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	r.Header.Set("User-Agent", "Anonymous-GitHub")
	client := *s.HTTP
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(r)
	if err != nil {
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 {
		return
	}
	var entries []M
	if json.Unmarshal(raw, &entries) != nil {
		return
	}
	chosen := ""
	for _, entry := range entries {
		if entry["verified"] != true {
			continue
		}
		email := normalizeNotificationEmail(entry["email"])
		if email == "" {
			continue
		}
		domain := strings.ToLower(strings.SplitN(email, "@", 2)[1])
		if domain == "users.noreply.github.com" || domain == "noreply.github.com" {
			continue
		}
		if chosen == "" || entry["primary"] == true {
			chosen = email
		}
		if entry["primary"] == true {
			break
		}
	}
	if chosen == "" {
		return
	}
	previous := user["emails"]
	if previous == nil {
		previous = []any{}
	}
	alternatives := []M{{"emails": previous}}
	if len(arr(previous)) == 0 {
		alternatives = append(alternatives, M{"emails": M{"$exists": false}})
	}
	emails := []M{{"email": chosen, "default": true}}
	ok, err := s.Store.update(work, "users", M{"_id": user["_id"], "notificationEmail": user["notificationEmail"], "$or": alternatives}, M{"$set": M{"emails": emails}})
	if err == nil && ok {
		user["emails"] = emails
	}
}
