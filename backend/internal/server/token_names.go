package server

import (
	"strings"
	"unicode"
)

func adminTokenName(value any) (string, error) {
	if !inputTruthy(value) {
		return "unnamed", nil
	}
	name, err := tokenNameString(value)
	if err != nil {
		return "", err
	}
	name = strings.TrimFunc(name, func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' })
	if name == "" {
		name = "unnamed"
	}
	return name, nil
}

// JSON values use JavaScript's toString/Array.join semantics for token names.
func tokenNameString(value any) (string, error) {
	if value == nil {
		return "", nil
	}
	if text, ok := termString(value); ok {
		return text, nil
	}
	switch value.(type) {
	case []any:
		parts := []string{}
		for _, v := range arr(value) {
			text, err := tokenNameString(v)
			if err != nil {
				return "", err
			}
			parts = append(parts, text)
		}
		return strings.Join(parts, ","), nil
	default:
		if _, shadowed := obj(value)["toString"]; shadowed {
			return "", fail("internal_error", 500)
		}
		return "[object Object]", nil
	}
}
