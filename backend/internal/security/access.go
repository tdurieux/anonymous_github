package security

import (
	"errors"
	"net/url"
	"path"
	"regexp"
	"strings"
)

type Identity struct {
	ID, Username, GitHubID, Status string
	Admin                          bool
}
type Coauthor struct {
	Username string `json:"username" bson:"username"`
	GitHubID string `json:"githubId" bson:"githubId"`
}

func (u Identity) Active() bool { return u.ID != "" && u.Status != "banned" && u.Status != "removed" }
func (u Identity) CanEdit(owner string, coauthors []Coauthor) bool {
	if !u.Active() {
		return false
	}
	if u.Admin || u.ID == owner {
		return true
	}
	for _, c := range coauthors {
		if c.GitHubID != "" {
			if u.GitHubID != "" && u.GitHubID == c.GitHubID {
				return true
			}
		} else if u.Username != "" && u.Username == c.Username {
			return true
		}
	}
	return false
}
func (u Identity) Owns(owner string) bool { return u.Active() && (u.Admin || u.ID == owner) }

var safeReturn = regexp.MustCompile(`^/(?:(?:anonymize|pull-request-anonymize|gist-anonymize)(?:/[\w-]+)?|connections|dashboard)(?:\?[^\\\r\n]*)?$`)

func ReturnTo(value, fallback string) string {
	if safeReturn.MatchString(value) {
		return value
	}
	return fallback
}

// RelativePath rejects ambiguous separators before cleaning. Callers must use
// os.Root for disk access as well, to prevent symlink traversal and TOCTOU races.
func RelativePath(value string) (string, error) {
	if value == "" || strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\\\x00") {
		return "", errors.New("invalid_file_path")
	}
	for _, s := range strings.Split(value, "/") {
		if s == "" || s == "." || s == ".." {
			return "", errors.New("invalid_file_path")
		}
	}
	return path.Clean(value), nil
}
func DecodePath(value string) (string, error) {
	s, e := url.PathUnescape(value)
	if e != nil {
		return "", errors.New("invalid_file_path")
	}
	return RelativePath(s)
}
