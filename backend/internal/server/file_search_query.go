package server

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf16"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func fileSearchQuery(raw string) (string, bool, error) {
	value := parseExtendedQuery(raw).object["q"]
	if !value.truthy() {
		return "", false, nil
	}
	query, scalar := value.scalarValue()
	if !scalar {
		return "", false, errors.New("invalid_query_value")
	}
	query = strings.TrimFunc(query, func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' })
	// JavaScript tests the trimmed UTF-16 length before lowercasing.
	if len(utf16.Encode([]rune(query))) < 2 {
		return "", false, nil
	}
	query = cases.Lower(language.Und).String(query)
	if strings.Contains(query, "/") {
		return "", false, nil
	}
	return query, true, nil
}
