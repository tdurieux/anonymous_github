package server

import "github.com/tdurieux/anonymous_github/backend/internal/provider"

// Providers receive a selected branch string, not Express query objects.
func previewBranchQuery(raw, fallback string) (string, error) {
	value := parseExtendedQuery(raw).object["branch"]
	if !value.truthy() {
		return fallback, nil
	}
	branch, err := value.stringValue()
	if err != nil {
		return "", err
	}
	if branch == "" {
		return "", fail("readme_not_available", 404)
	}
	return branch, nil
}

func previewBranchMatch(raw, fallback string) provider.BranchMatch {
	value := parseExtendedQuery(raw).object["branch"]
	return func(name string) (bool, error) {
		if !value.truthy() {
			return name == fallback, nil
		}
		return value.looseStringEqual(name)
	}
}
