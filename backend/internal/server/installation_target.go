package server

import (
	"context"
	"net/url"
)

func singleQueryValue(query url.Values, key string) (string, bool) {
	values := query[key]
	if len(values) != 1 {
		return "", false
	}
	return values[0], true
}

func installationSettingsURL(installation M) string {
	id := segment(str(installation["id"]))
	account := obj(installation["account"])
	if str(account["type"]) == "Organization" {
		return "https://github.com/organizations/" + segment(str(account["login"])) + "/settings/installations/" + id
	}
	return "https://github.com/settings/installations/" + id
}

func (s *Server) installationTarget(ctx context.Context, owner any, query map[string]*queryValue, installations []M) (string, error) {
	target := "https://github.com/apps/" + segment(s.Config.AppSlug) + "/installations/new"
	if id, ok := query["installationId"].scalarValue(); ok {
		for _, installation := range installations {
			if str(installation["id"]) == id {
				return installationSettingsURL(installation), nil
			}
		}
		return "", fail("github_app_access_required", 403)
	}
	repository, ok := query["repository"].scalarValue()
	if !ok || !safeRepositoryName(repository) {
		return target, nil
	}
	token, err := s.storedGrantToken(ctx, owner, "github")
	if err != nil {
		return "", err
	}
	if token == "" {
		token, err = s.credential(ctx, owner, "github-app-user")
		if err != nil {
			return "", err
		}
	}
	repo, err := s.githubObject(ctx, "GET", "/repos/"+repository, token, nil)
	if err != nil {
		return target, nil
	} // Private repositories may be invisible until installation.
	accountID := obj(repo["owner"])["id"]
	for _, installation := range installations {
		if accountID != nil && str(obj(installation["account"])["id"]) == str(accountID) {
			return installationSettingsURL(installation), nil
		}
	}
	if inputTruthy(accountID) {
		values := url.Values{"suggested_target_id": []string{str(accountID)}, "repository_ids[]": []string{str(repo["id"])}}
		target += "/permissions?" + values.Encode()
	}
	return target, nil
}
