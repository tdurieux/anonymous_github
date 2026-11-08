package filetype

import (
	_ "embed"
	"encoding/json"
	"strings"
)

//go:embed compressible.json
var compressibleJSON []byte
var compressibleTypes = func() map[string]bool {
	var v map[string]bool
	if err := json.Unmarshal(compressibleJSON, &v); err != nil {
		panic(err)
	}
	return v
}()

func Compressible(contentType string) bool {
	value := strings.TrimSpace(contentType)
	if i := strings.IndexAny(value, "; \t\r\n"); i >= 0 {
		value = value[:i]
	}
	value = strings.ToLower(value)
	if v, ok := compressibleTypes[value]; ok {
		return v
	}
	return strings.HasPrefix(value, "text/") || strings.HasSuffix(value, "+json") || strings.HasSuffix(value, "+text") || strings.HasSuffix(value, "+xml")
}
