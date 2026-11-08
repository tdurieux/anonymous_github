package server

import (
	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"net/url"
	"strings"
	"time"
)

func queryEscape(s string) string { return url.QueryEscape(s) }
func (s *Server) register() {
	s.registerAdmin()
	s.add("GET", "/api/providers", "user", s.providerCapabilities)
	s.add("GET", "/api/providers/:provider/gist/:id", "user", s.embeddedSource("gist"))
	s.add("GET", "/api/providers/:provider/pr/:id", "user", s.embeddedSource("pr"))
	s.add("GET", "/api/providers/:provider/repositories", "user", s.allRepositories)
	for _, mode := range []string{"metadata", "branches", "readme"} {
		s.add("GET", "/api/providers/:provider/repository/"+mode, "user", s.sourceRepository(mode))
	}
	s.add("GET", "/script/go-project-page.js", "", s.projectPageScript)
	s.add("POST", "/api/repo/claim", "user", s.claim)
	s.add("GET", "/api/stat", "", s.stats)
	s.add("GET", "/api/stat/history", "", s.stats)
	s.add("GET", "/api/message", "", s.message)
	s.add("GET", "/api/gist/source/:id", "user", s.embeddedSource("gist"))
	s.add("GET", "/api/pr/:owner/:repository/:id", "user", s.embeddedSource("pr"))
	s.add("GET", "/w/:id/*path", "", s.webview)
	s.add("GET", "/w/:id", "", func(q *request) (any, error) {
		if !strings.HasSuffix(q.R.URL.Path, "/") {
			return q.redirect(q.R.URL.Path + "/"), nil
		}
		return s.webview(q)
	})
	for _, method := range []string{"GET", "PATCH"} {
		s.add(method, "/api/maintenance/repositories/:id", "user", s.maintenanceResource)
	}
	for _, method := range []string{"GET", "POST"} {
		s.add(method, "/api/user/maintenance-tokens", "user", s.maintenanceTokens)
	}
	s.add("DELETE", "/api/user/maintenance-tokens/:id", "user", s.maintenanceTokens)
	s.add("GET", "/github/app/install", "user", s.appInstall)
	s.add("GET", "/github/app/setup", "", s.appInstall)
	s.add("GET", "/github/connections", "user", s.connections)
	s.add("POST", "/github/connections/migrate", "user", s.connections)
	s.add("POST", "/github/connections/disconnect-oauth", "user", s.connections)
	s.add("DELETE", "/api/user", "user", s.deleteAccount)
	s.add("GET", "/api/conferences/plans", "user", func(q *request) (any, error) { return plans, nil })
	for _, method := range []string{"GET", "POST"} {
		s.add(method, "/api/conferences", "user", s.conferences)
	}
	for _, method := range []string{"GET", "POST", "DELETE"} {
		s.add(method, "/api/conferences/:id", "user", s.conferences)
	}
	s.add("GET", "/api/user/dashboard", "user", s.dashboard)
	s.add("GET", "/api/options", "", func(q *request) (any, error) {
		return M{"GITHUB_APP_ENABLED": s.Config.AppEnabled && s.Config.AppNewConnections, "GITHUB_OAUTH_ENABLED": s.Config.OAuthEnabled, "ENABLE_DOWNLOAD": s.Config.Download, "MAX_FILE_SIZE": anonymize.MaxInput, "MAX_REPO_SIZE": 60000, "ANONYMIZATION_MASK": s.Config.Mask}, nil
	})
	s.add("POST", "/api/anonymize-preview", "user", s.preview)
	s.add("POST", "/github/login-token", "", s.loginToken)
	for _, prefix := range []string{"/github", "/github/app"} {
		s.add("GET", prefix+"/login", "", s.oauthStart)
	}
	s.add("GET", "/github/auth", "", s.oauthCallback)
	s.add("GET", "/github/app/callback", "", s.oauthCallback)
	s.add("GET", "/github/account-recovery", "", func(q *request) (any, error) {
		flow := obj(q.Session["githubRecovery"])
		return M{"required": number(flow["expires"]) > time.Now().UnixMilli()}, nil
	})
	s.add("GET", "/api/user/logout", "user", s.logout)
	s.add("GET", "/api/user", "user", func(q *request) (any, error) {
		return userProfile(q.User), nil
	})
	s.add("GET", "/api/user/default", "user", func(q *request) (any, error) { return userDefaults(q.User), nil })
	s.add("POST", "/api/user/default", "user", func(q *request) (any, error) {
		value, err := castUserDefaults(q.Body)
		if err != nil {
			return nil, err
		}
		_, err = s.Store.update(q.ctx(), "users", M{"_id": q.User["_id"]}, M{"$set": M{"default": value}})
		if err != nil {
			return nil, err
		}
		return q.text("ok"), nil
	})
	s.add("GET", "/api/user/quota", "user", s.quota)
	s.add("POST", "/api/user/project-name", "user", s.projectName)
	s.add("GET", "/api/user/search/github-users", "user", s.githubUsers)
	s.add("GET", "/api/user/all_repositories", "user", s.allRepositories)
	s.add("GET", "/api/user/:username/all_repositories", "user", s.allRepositories)
	for kind, suffix := range map[string]string{"repo": "repositories", "pr": "pull_requests", "gist": "gists"} {
		s.add("GET", "/api/user/anonymized_"+suffix, "user", s.userResources(kind))
	}
	s.add("GET", "/api/admin/tokens", "admin", s.tokens)
	s.add("POST", "/api/admin/tokens", "admin", s.tokens)
	s.add("DELETE", "/api/admin/tokens/:id", "admin", s.tokens)
	for _, kind := range []string{"repo", "pr", "gist"} {
		prefix := "/api/" + kind
		s.add("GET", prefix+"/:id/options", "", s.publicOptions(kind))
		if kind != "repo" {
			s.add("GET", prefix+"/:id/content", "", s.embeddedContent(kind))
		}
		s.add("GET", prefix+"/:id", "user", s.privateResource(kind))
		s.add("POST", prefix, "user", s.saveResource(kind, true))
		s.add("POST", prefix+"/:id", "user", s.saveResource(kind, false))
		s.add("DELETE", prefix+"/:id", "user", s.lifecycle(kind, "remove"))
		s.add("POST", prefix+"/:id/refresh", "user", s.lifecycle(kind, "refresh"))
		s.add("POST", prefix+"/:id/extend", "user", s.lifecycle(kind, "extend"))
	}
	s.add("GET", "/api/repo/:id/files", "", s.files("list"))
	s.add("GET", "/api/repo/:id/files/search", "", s.files("search"))
	s.add("GET", "/api/repo/:id/files/counts", "", s.files("counts"))
	s.add("GET", "/api/repo/:id/coauthors", "user", s.coauthors)
	s.add("POST", "/api/repo/:id/coauthors", "user", s.coauthors)
	s.add("DELETE", "/api/repo/:id/coauthors/:username", "user", s.coauthors)
	s.add("GET", "/api/repo/:id/file/*path", "", s.file)
	s.add("GET", "/api/repo/:id/zip", "", s.zip)
	s.add("GET", "/api/repo/:owner/:repo/branches", "user", s.sourceRepository("branches"))
	s.add("GET", "/api/repo/:owner/:repo/readme", "user", s.sourceRepository("readme"))
	s.add("GET", "/api/repo/:owner/:repo", "user", s.sourceRepository("metadata"))
}
