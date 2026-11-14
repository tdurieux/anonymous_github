package server

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

// Keep the client-visible validation order separate from provider connection and
// authorization. Adapters still validate their own repository/revision syntax.
func validateResourceInput(kind string, body M) error {
	return validateResourceProviderInput(kind, body, "")
}
func validateResourceProviderInput(kind string, body M, existingProvider string) error {
	id, ok := body[idKey(kind)].(string)
	if !ok || !resourceID.MatchString(id) {
		return fail("invalid_"+idKey(kind), 400)
	}
	source := obj(body["source"])
	switch kind {
	case "repo":
		if !inputTruthy(body["source"]) {
			return fail("source_not_provided", 400)
		}
		if !inputTruthy(source["branch"]) {
			return fail("branch_not_specified", 400)
		}
		if !inputTruthy(source["commit"]) {
			return fail("commit_not_specified", 400)
		}
	case "gist":
		if !inputTruthy(source["gistId"]) {
			return fail("gistId_not_specified", 400)
		}
	case "pr":
		if !inputTruthy(source["repositoryFullName"]) {
			return fail("repository_not_specified", 400)
		}
		if !inputTruthy(source["pullRequestId"]) {
			return fail("pullRequestId_not_specified", 400)
		}
		if !integerInput(source["pullRequestId"]) {
			return fail("pullRequestId_is_not_a_number", 400)
		}
	}
	if !inputTruthy(body["options"]) {
		return fail("options_not_provided", 400)
	}
	if _, ok := body["terms"].([]any); !ok {
		return fail("invalid_terms_format", 400)
	}
	if kind == "repo" {
		id, e := sourceProvider(source)
		if source["provider"] == nil && existingProvider != "" {
			id, e = existingProvider, nil
		}
		if e == nil && id == "github" && !commitID.MatchString(str(source["commit"])) {
			return fail("invalid_commit_format", 400)
		}
	}
	return nil
}
func inputTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	case int64:
		return x != 0
	}
	return true
}
func integerInput(v any) bool {
	switch x := v.(type) {
	case float64:
		return !math.IsNaN(x) && !math.IsInf(x, 0) && math.Trunc(x) == x && math.Abs(x) < 1e21
	case int, int64:
		return true
	case string:
		text := strings.TrimSpace(x)
		if text == "" {
			return false
		}
		if strings.HasPrefix(text, "0x") || strings.HasPrefix(text, "0X") {
			_, e := strconv.ParseUint(text[2:], 16, 64)
			return e == nil
		}
		n, e := strconv.ParseFloat(text, 64)
		if e != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return false
		}
		end := 0
		if text[0] == '+' || text[0] == '-' {
			end = 1
		}
		start := end
		for end < len(text) && text[end] >= '0' && text[end] <= '9' {
			end++
		}
		if end == start {
			return false
		}
		integer, e := strconv.ParseFloat(text[:end], 64)
		return e == nil && integer == n
	}
	return false
}

func normalizedIntegerInput(v any) any {
	if text, ok := v.(string); ok {
		text = strings.TrimSpace(text)
		if strings.HasPrefix(text, "0x") || strings.HasPrefix(text, "0X") {
			n, e := strconv.ParseUint(text[2:], 16, 64)
			if e == nil {
				return float64(n)
			}
		}
		if n, e := strconv.ParseFloat(text, 64); e == nil {
			return n
		}
	}
	return v
}

// Mongoose Boolean casting is an explicit set, not JavaScript truthiness.
// In particular "false" must disable the option, and null stays null.
func optionBoolean(value any) (any, bool) {
	switch v := value.(type) {
	case nil, bool:
		return value, true
	case string:
		switch v {
		case "true", "1", "yes":
			return true, true
		case "false", "0", "no":
			return false, true
		}
	case float64:
		if v == 0 || v == 1 {
			return v == 1, true
		}
	case int:
		if v == 0 || v == 1 {
			return v == 1, true
		}
	case int64:
		if v == 0 || v == 1 {
			return v == 1, true
		}
	}
	return nil, false
}

// JSON numbers use the same shortest decimal/exponent form as JavaScript.
// Explicitly normalize negative zero, whose String() representation is "0".
func termString(value any) (string, bool) {
	switch v := value.(type) {
	case string:
		return v, true
	case bool:
		return strconv.FormatBool(v), true
	case int:
		return termString(float64(v))
	case int64:
		return termString(float64(v))
	case float64:
		if v == 0 {
			return "0", true
		}
		data, err := json.Marshal(v)
		return string(data), err == nil
	}
	return "", false
}

func shouldReactivateRepository(status string, options M, now time.Time) bool {
	if status != "expired" && status != "removed" {
		return false
	}
	return str(options["expirationMode"]) == "never" || date(options["expirationDate"]).After(now)
}

// jsonSafeInteger matches JavaScript Number.isSafeInteger for decoded JSON;
// strings and booleans must never be coerced into upstream identity numbers.
func jsonSafeInteger(value any) bool {
	id, ok := value.(float64)
	return ok && !math.IsNaN(id) && !math.IsInf(id, 0) && math.Trunc(id) == id && math.Abs(id) <= 9007199254740991
}

// MongoDB may decode integral fields as BSON integers rather than JSON doubles.
func storedSafeInteger(value any) bool {
	switch v := value.(type) {
	case int:
		return jsonSafeInteger(float64(v))
	case int32:
		return jsonSafeInteger(float64(v))
	case int64:
		return jsonSafeInteger(float64(v))
	default:
		return jsonSafeInteger(value)
	}
}
