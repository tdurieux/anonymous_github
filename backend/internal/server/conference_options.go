package server

import (
	"math"
)

// Mongoose minimizes empty option objects, but retains explicit null and other
// falsy scalar values. Match its stored representation and supported casts.
func conferenceOptions(body M) (M, error) {
	value, present := body["options"]
	if !present {
		return M{}, nil
	}
	if !inputTruthy(value) {
		return M{"options": value}, nil
	}
	switch value.(type) {
	case M, map[string]any, []any:
	default:
		return nil, fail("internal_error", 500)
	}
	opt := selectFields(obj(value), "expirationMode", "expirationDate", "update", "image", "pdf", "notebook", "link", "page")
	for _, key := range []string{"update", "image", "pdf", "notebook", "link", "page"} {
		if value, ok := opt[key]; ok {
			converted, valid := optionBoolean(value)
			if !valid {
				return nil, fail("internal_error", 500)
			}
			opt[key] = converted
		}
	}
	if value, ok := opt["expirationMode"]; ok && value != nil {
		converted, valid := termString(value)
		if !valid {
			return nil, fail("internal_error", 500)
		}
		opt["expirationMode"] = converted
	}
	if value, ok := opt["expirationDate"]; ok {
		if value == nil || value == "" {
			opt["expirationDate"] = nil
		} else {
			// Mongoose rejects booleans and treats numeric strings outside its
			// year range as milliseconds before invoking Date construction.
			if _, boolean := value.(bool); boolean {
				return nil, fail("internal_error", 500)
			}
			if text, ok := value.(string); ok {
				n := queryWindowNumber(text)
				if !math.IsNaN(n) && (n >= 275761 || n < -271820) {
					value = n
				}
			}
			parsed, valid, err := javascriptDateValue(value)
			if err != nil || !valid {
				return nil, fail("internal_error", 500)
			}
			opt["expirationDate"] = parsed
		}
	}
	if len(opt) == 0 {
		return M{}, nil
	}
	return M{"options": opt}, nil
}
