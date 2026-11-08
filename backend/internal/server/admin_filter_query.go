package server

import (
	"errors"
	"net/url"
)

// Status flags use loose string equality; search requires a string because
// TypeScript calls replace on it. Role selection uses strict scalar equality.
// Field predicate casting is handled separately for find/count and aggregation.
func adminFilterQuery(kind, raw string) (url.Values, error) {
	values, _ := url.ParseQuery(raw)
	query := parseExtendedQuery(raw).object
	if kind != "users" {
		for _, flag := range []string{"ready", "error", "preparing", "removed", "expired"} {
			match, err := query[flag].looseStringEqual("true")
			if err != nil {
				return nil, err
			}
			values.Del(flag)
			if match {
				values.Set(flag, "true")
			}
		}
	}
	values.Del("search")
	if query["search"].truthy() {
		search, scalar := query["search"].scalarValue()
		if !scalar {
			return nil, errors.New("invalid_query_value")
		}
		values.Set("search", search)
	}
	values.Del("role")
	if role, scalar := query["role"].scalarValue(); scalar && role == "admin" {
		values.Set("role", role)
	}
	return values, nil
}
