package server

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf16"
)

func dashboardFilter(query map[string]*queryValue) (M, error) {
	filter := M{}
	kind, err := query["type"].stringValue()
	if err != nil {
		return nil, err
	}
	if collection(kind) != "" {
		filter["_type"] = query["type"].nativeValue()
	}
	if value := query["attention"]; value != nil && value.kind == 's' && value.scalar == "true" {
		filter["_attention"] = true
	}
	statuses, err := query["statuses"].stringDefault("ready,progress,error,expired")
	if err != nil {
		return nil, err
	}
	valid := []string{}
	for _, status := range strings.Split(statuses, ",") {
		switch status {
		case "ready", "progress", "error", "expired", "removed":
			valid = append(valid, status)
		}
	}
	filter["_statusKey"] = M{"$in": valid}
	rawSearch, err := query["q"].stringDefault("")
	if err != nil {
		return nil, err
	}
	search := strings.TrimFunc(rawSearch, func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' })
	units := utf16.Encode([]rune(search))
	if len(units) > 256 {
		units = units[:256]
	}
	// A split surrogate is encoded as U+FFFD by Node's BSON UTF-8 writer.
	search = string(utf16.Decode(units))
	if search != "" {
		clauses := []M{}
		for _, field := range []string{"_anonymousId", "_label", "_source", "conference"} {
			clauses = append(clauses, M{field: M{"$regex": regexp.QuoteMeta(search), "$options": "i"}})
		}
		filter["$or"] = clauses
	}
	return filter, nil
}
