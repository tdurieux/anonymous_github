package server

import (
	"strings"
	"unicode"
)

func utf16Length(value string) int {
	n := 0
	for _, r := range value {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}

func validateProjectName(body M) (kind, id, name string, err error) {
	kind, typeOK := body["type"].(string)
	id, idOK := body["id"].(string)
	name, nameOK := body["name"].(string)
	trimmed := strings.TrimFunc(name, func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' })
	invalid := !typeOK || collection(kind) == "" || !idOK || id == "" || utf16Length(id) > 250 || !nameOK || utf16Length(trimmed) > 100
	for _, r := range name {
		if r < 32 || r == 127 {
			invalid = true
			break
		}
	}
	if invalid {
		return "", "", "", fail("invalid_project_name", 400)
	}
	return kind, id, trimmed, nil
}
