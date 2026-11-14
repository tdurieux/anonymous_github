package server

import (
	"regexp"
	"strings"
)

var githubReconnectID = regexp.MustCompile(`^gh_[1-9][0-9]*$`)

// Reconnect is an owner-only operation pinned to the preview's upstream ID.
// Test key presence: JSON null is an invalid reconnect, not a settings-only save.
func validateRepositoryReconnect(q *request, previous M, providerID string) (bool, string, error) {
	value, present := q.Body["reconnectRepositoryId"]
	if previous == nil || !present {
		return false, "", nil
	}
	if q.Identity.ID != str(previous["owner"]) {
		return true, "", fail("not_owner", 403)
	}
	id, valid := value.(string)
	prefix := providerID + "_"
	if providerID == "github" {
		prefix = "gh_"
	}
	valid = valid && strings.HasPrefix(id, prefix) && len(id) > len(prefix)
	if providerID == "github" {
		valid = valid && githubReconnectID.MatchString(id)
	}
	name, stringName := q.Body["fullName"].(string)
	if !valid || !stringName || name != str(obj(previous["source"])["repositoryName"]) {
		return true, "", fail("repo_not_found", 400)
	}
	switch str(previous["status"]) {
	case "preparing", "queue", "download", "removing", "expiring":
		return true, "", fail("invalid_status", 409)
	case "archived":
		return true, "", fail("repository_archived", 410)
	}
	return true, id, nil
}
