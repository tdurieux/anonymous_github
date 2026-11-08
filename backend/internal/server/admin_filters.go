package server

import (
	"net/url"
	"strings"
	"unicode"
)

func adminSearchPattern(value string) string {
	var out strings.Builder
	for _, r := range value {
		if strings.ContainsRune(`-[]{}()*+?.,\^$|#`, r) || (unicode.IsSpace(r) && r != '\u0085') || r == '\ufeff' {
			out.WriteByte('\\')
		}
		out.WriteRune(r)
	}
	return out.String()
}

// owner is resolved only for repository queries. A missing owner returns the
// same empty response as TypeScript, rather than matching ownerless records.
type adminFilterOptions struct {
	Fields   M
	RawQuery string
}

func adminFilter(kind string, v url.Values, owner M, overrides ...adminFilterOptions) (M, bool, error) {
	rawQuery := v.Encode()
	fields := M{}
	for _, key := range []string{"owner", "conference", "status"} {
		if value := v.Get(key); value != "" {
			fields[key] = value
		}
	}
	if len(overrides) > 0 {
		fields = overrides[0].Fields
		rawQuery = overrides[0].RawQuery
	}
	filter := M{}
	clauses := []M{}
	add := func(value M) {
		if kind == "users" {
			for k, v := range value {
				filter[k] = v
			}
		} else {
			clauses = append(clauses, value)
		}
	}
	if search := v.Get("search"); search != "" {
		re := M{"$regex": adminSearchPattern(search), "$options": "i"}
		fields := []string{"repoId", "source.repositoryName", "statusMessage", "conference"}
		if kind == "users" {
			fields = []string{"username", "emails.email"}
		}
		if kind == "conferences" {
			fields = []string{"name", "conferenceID"}
		}
		or := []M{}
		for _, field := range fields {
			or = append(or, M{field: re})
		}
		add(M{"$or": or})
	}
	if kind == "repos" {
		if _, present := fields["owner"]; present {
			if owner == nil {
				return M{"$and": clauses}, true, nil
			}
			add(M{"owner": owner["_id"]})
		}
		if conference, present := fields["conference"]; present {
			add(M{"conference": conference})
		}
	}
	if kind == "users" {
		if status, present := fields["status"]; present {
			add(M{"status": status})
		}
		if v.Get("role") == "admin" {
			add(M{"isAdmin": true})
		}
	}
	dateField := "anonymizeDate"
	if kind == "users" {
		dateField = "dateOfEntry"
	}
	if kind == "conferences" {
		dateField = "startDate"
	}
	dates, err := adminDateRange(rawQuery)
	if err != nil {
		return nil, false, err
	}
	if len(dates) > 0 {
		add(M{dateField: dates})
	}
	if kind != "users" {
		statuses := []M{}
		order := []string{"ready", "error", "expired", "removed", "preparing"}
		if kind == "conferences" {
			order = []string{"ready", "error", "preparing", "expired", "removed"}
		}
		for _, flag := range order {
			if v.Get(flag) != "true" {
				continue
			}
			states := []string{flag}
			if kind == "repos" {
				switch flag {
				case "expired":
					states = []string{"expiring", "expired"}
				case "removed":
					states = []string{"removing", "removed"}
				case "preparing":
					states = []string{"preparing", "download"}
				}
			}
			for _, state := range states {
				statuses = append(statuses, M{"status": state})
			}
		}
		if len(statuses) > 0 {
			add(M{"$or": statuses})
		}
		if len(clauses) > 0 {
			filter["$and"] = clauses
		}
	}
	return filter, false, nil
}
