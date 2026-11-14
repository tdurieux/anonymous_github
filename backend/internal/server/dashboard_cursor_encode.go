package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"math"
)

func encodeDashboardCursor(sort string, last M) (string, error) {
	value := responseJSON(last["_sort"])
	switch n := value.(type) {
	case int:
		value = float64(n)
	case int32:
		value = float64(n)
	case int64:
		value = float64(n)
	case float32:
		value = float64(n)
	}
	if n, ok := value.(float64); ok {
		if math.IsInf(n, 0) || math.IsNaN(n) {
			value = nil
		} else if n == 0 {
			value = float64(0)
		}
	}
	// JSON.stringify preserves this property order. Dates use JavaScript's
	// millisecond representation before the bytes are base64url encoded.
	payload := struct {
		Sort  string `json:"sort"`
		Value any    `json:"value"`
		Type  string `json:"type"`
		ID    string `json:"id"`
	}{sort, value, str(last["_type"]), str(last["_id"])}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		return "", err
	}
	raw := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	// Go escapes JavaScript line separators even with EscapeHTML disabled.
	// Skip escaped backslashes so literal text such as "\\u2028" stays literal.
	normalized := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+1 < len(raw) {
			if i+5 < len(raw) && string(raw[i:i+5]) == `\u202` && (raw[i+5] == '8' || raw[i+5] == '9') {
				normalized = append(normalized, 0xe2, 0x80, 0xa8+raw[i+5]-'8')
				i += 5
				continue
			}
			normalized = append(normalized, raw[i], raw[i+1])
			i++
			continue
		}
		normalized = append(normalized, raw[i])
	}
	return base64.RawURLEncoding.EncodeToString(normalized), nil
}
