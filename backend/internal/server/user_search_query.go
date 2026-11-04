package server

import (
	"errors"
	"strings"
)

// The legacy route tests q.length before obtaining credentials. Arrays use
// their compacted element count; objects may supply their own length property.
func userSearchQuery(raw string) (*queryValue, bool, error) {
	value := parseExtendedQuery(raw).object["q"]
	if !value.truthy() {
		return value, false, nil
	}
	switch value.kind {
	case 's':
		return value, githubUserSearchable(value.scalar), nil
	case 'a':
		count := 0
		for _, item := range value.array {
			if item != nil {
				count++
			}
		}
		return value, count >= 2, nil
	default:
		length, err := value.object["length"].stringValue()
		if err != nil {
			return value, false, err
		}
		return value, !(queryWindowNumber(length) < 2), nil
	}
}

// Octokit's search endpoint calls split on q after credential lookup. Preserve
// that rejection timing and its treatment of literal plus signs as separators.
func userSearchPath(value *queryValue) (string, error) {
	query, scalar := value.scalarValue()
	if !scalar {
		return "", errors.New("invalid_query_value")
	}
	return "/search/users?q=" + strings.ReplaceAll(queryEscape(query), "%2B", "+") + "&per_page=10", nil
}
