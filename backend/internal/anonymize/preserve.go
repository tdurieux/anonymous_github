package anonymize

import (
	"errors"
	"strings"
	"unicode/utf16"
)

// NormalizePreserveFiles keeps the last duplicate because the last matching
// include/exclude rule decides whether term replacement is disabled.
func NormalizePreserveFiles(value any) ([]string, error) {
	out := []string{}
	if value == nil {
		return out, nil
	}
	var values []any
	switch v := value.(type) {
	case []any:
		values = v
	case []string:
		for _, s := range v {
			values = append(values, s)
		}
	default:
		return nil, errors.New("invalid_preserve_files_format")
	}
	for _, v := range values {
		s, ok := v.(string)
		if !ok {
			return nil, errors.New("invalid_preserve_files_format")
		}
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		body := strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(s, "!"), "/"), "/")
		if len(utf16.Encode([]rune(s))) > 512 || body == "" {
			return nil, errors.New("invalid_preserve_files_format")
		}
		for _, part := range strings.Split(body, "/") {
			if part == "" || part == ".." {
				return nil, errors.New("invalid_preserve_files_format")
			}
		}
		next := out[:0]
		for _, old := range out {
			if old != s {
				next = append(next, old)
			}
		}
		out = append(next, s)
	}
	if len(out) > 200 {
		return nil, errors.New("invalid_preserve_files_format")
	}
	return out, nil
}
func preserveGlob(pattern, candidate string) bool {
	budget := 4096
	for _, expanded := range expandPreserveBraces(pattern, &budget) {
		if preserveExpandedGlob(expanded, candidate) {
			return true
		}
	}
	return false
}
func preserveExpandedGlob(pattern, candidate string) bool {
	// Globstar crosses directory boundaries. Other wildcards use path.Match's
	// component-local matching, including bracket classes and backslash escapes.
	parts, values := strings.Split(pattern, "/"), strings.Split(candidate, "/")
	type key struct{ i, j int }
	memo := map[key]bool{}
	seen := map[key]bool{}
	var match func(int, int) bool
	match = func(i, j int) bool {
		k := key{i, j}
		if seen[k] {
			return memo[k]
		}
		seen[k] = true
		result := false
		if i == len(parts) {
			result = j == len(values)
		} else if parts[i] == "**" {
			result = match(i+1, j) || (j < len(values) && match(i, j+1))
			if i == len(parts)-1 {
				result = j < len(values) || i == 0
			}
		} else if j < len(values) {
			ok := preserveComponent(parts[i], values[j])
			result = ok && match(i+1, j+1)
		}
		memo[k] = result
		return result
	}
	return match(0, 0)
}
func PreservedPath(file string, patterns []string) bool {
	file = strings.TrimLeft(file, "/")
	if file == "" {
		return false
	}
	parts := strings.Split(file, "/")
	result := false
	for _, rule := range patterns {
		negated := strings.HasPrefix(rule, "!")
		body := strings.TrimPrefix(rule, "!")
		anchored := strings.HasPrefix(body, "/")
		body = strings.TrimPrefix(body, "/")
		directory := strings.HasSuffix(body, "/")
		body = strings.TrimSuffix(body, "/")
		if result != negated {
			continue
		}
		end := len(parts)
		if directory {
			end--
		}
		for i := 1; i <= end; i++ {
			candidate := strings.Join(parts[:i], "/")
			if !anchored && !strings.Contains(body, "/") {
				candidate = parts[i-1]
			}
			if preserveGlob(body, candidate) {
				result = !negated
				break
			}
		}
	}
	return result
}
