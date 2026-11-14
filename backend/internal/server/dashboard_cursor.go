package server

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

func dashboardCursor(encoded, sort, field string) (M, error) {
	invalid := func() (M, error) { return nil, fail("invalid_cursor", 400) }
	if utf16Length(encoded) > 2048 {
		return invalid()
	}
	// Node's base64url decoder accepts both alphabets, optional padding and
	// whitespace. JSON validation still applies to the complete decoded payload.
	encoded = strings.SplitN(encoded, "=", 2)[0]
	encoded = strings.Map(func(r rune) rune {
		switch {
		case r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			return r
		case r == '-' || r == '+':
			return '-'
		case r == '_' || r == '/':
			return '_'
		}
		return -1
	}, encoded)
	if len(encoded)%4 == 1 {
		encoded = encoded[:len(encoded)-1]
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return invalid()
	}
	var cursor M
	if json.Unmarshal(raw, &cursor) != nil {
		return invalid()
	}
	actualSort, sortOK := cursor["sort"].(string)
	_, typeOK := cursor["type"].(string)
	idText, idOK := cursor["id"].(string)
	if !sortOK || actualSort != sort || !typeOK || !idOK {
		return invalid()
	}
	id, err := oid(idText)
	if err != nil {
		return invalid()
	}
	value, present := cursor["value"]
	if !present {
		return invalid()
	}
	if field == "anonymizeDate" || field == "lastView" || field == "options.expirationDate" {
		parsed, ok := dashboardCursorDate(value)
		if !ok {
			return invalid()
		}
		value = parsed
	} else {
		switch value.(type) {
		case string, float64:
		default:
			return invalid()
		}
	}
	return M{"sort": sort, "type": cursor["type"], "id": id, "value": value}, nil
}

func dashboardCursorDate(value any) (time.Time, bool) {
	parsed, ok, err := javascriptDateValue(value)
	return parsed, ok && err == nil
}
