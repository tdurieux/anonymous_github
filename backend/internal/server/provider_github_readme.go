package server

import (
	"encoding/hex"
	"math"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	unicodeencoding "golang.org/x/text/encoding/unicode"
)

// Match Buffer.from(content, encoding).toString("utf-8") at the GitHub
// boundary. Other providers return normalized text through Discovery.Readme.
func decodeGitHubReadme(v any) (string, error) {
	response := obj(v)
	var data []byte
	invalid := func() (string, error) { return "", fail("github_invalid_response", 502) }
	switch content := response["content"].(type) {
	case string:
		if len(content) > maxReadmeBytes {
			return invalid()
		}
		encoding, _ := response["encoding"].(string)
		switch strings.ToLower(encoding) {
		case "", "utf8", "utf-8":
			if utf8.ValidString(content) {
				return content, nil
			}
			data = []byte(content)
		case "base64", "base64url":
			// Node accepts either alphabet, skips non-alphabet bytes, permits missing
			// padding, and stops at the first '='. UTF-16 units are narrowed to bytes.
			var bits uint32
			var width uint
			readmeUnits(content, func(unit uint16) bool {
				ch := byte(unit)
				if ch == '=' {
					return false
				}
				var value byte
				switch {
				case ch >= 'A' && ch <= 'Z':
					value = ch - 'A'
				case ch >= 'a' && ch <= 'z':
					value = ch - 'a' + 26
				case ch >= '0' && ch <= '9':
					value = ch - '0' + 52
				case ch == '+' || ch == '-':
					value = 62
				case ch == '/' || ch == '_':
					value = 63
				default:
					return true
				}
				bits = bits<<6 | uint32(value)
				width += 6
				if width >= 8 {
					width -= 8
					data = append(data, byte(bits>>width))
				}
				return true
			})
		case "hex":
			// DecodeString returns the valid prefix before an invalid or odd pair.
			narrowed := make([]byte, 0, len(content))
			readmeUnits(content, func(unit uint16) bool { narrowed = append(narrowed, byte(unit)); return true })
			data, _ = hex.DecodeString(string(narrowed))
		case "ascii", "latin1", "binary":
			readmeUnits(content, func(unit uint16) bool { data = append(data, byte(unit)); return true })
		case "ucs2", "ucs-2", "utf16le", "utf-16le":
			if utf16Length(content) > maxReadmeBytes/2 {
				return invalid()
			}
			readmeUnits(content, func(unit uint16) bool { data = append(data, byte(unit), byte(unit>>8)); return true })
		default:
			return invalid()
		}
	case []any:
		if len(content) > maxReadmeBytes {
			return invalid()
		}
		data = make([]byte, len(content))
		for i, value := range content {
			decoded, err := readmeByte(value)
			if err != nil {
				return invalid()
			}
			data[i] = decoded
		}
	default:
		if response["content"] == nil {
			return invalid()
		}
		object := obj(content)
		if length, ok := object["length"]; ok {
			n, ok := length.(float64)
			if !ok || math.IsNaN(n) || n <= 0 {
				data = []byte{}
			} else {
				if math.IsInf(n, 0) || n > maxReadmeBytes {
					return invalid()
				}
				data = make([]byte, int(n))
				for i := range data {
					decoded, err := readmeByte(object[strconv.Itoa(i)])
					if err != nil {
						return invalid()
					}
					data[i] = decoded
				}
			}
		} else if object["type"] == "Buffer" {
			values, ok := object["data"].([]any)
			if !ok || len(values) > maxReadmeBytes {
				return invalid()
			}
			data = make([]byte, len(values))
			for i, value := range values {
				decoded, err := readmeByte(value)
				if err != nil {
					return invalid()
				}
				data[i] = decoded
			}
		} else {
			return invalid()
		}
	}
	if len(data) > maxReadmeBytes {
		return invalid()
	}
	if utf8.Valid(data) {
		return string(data), nil
	}
	decoded, err := unicodeencoding.UTF8.NewDecoder().Bytes(data)
	if err != nil {
		return invalid()
	}
	return string(decoded), nil
}

// Array-like API responses must not turn a tiny JSON body into an unbounded
// allocation. Normal GitHub base64 responses fit within the HTTP body limit.
const maxReadmeBytes = 32 * 1024 * 1024

func readmeByte(value any) (byte, error) {
	var n float64
	switch v := value.(type) {
	case float64:
		n = v
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	case bool:
		if v {
			n = 1
		}
	default:
		text, err := tokenNameString(value)
		if err != nil {
			return 0, err
		}
		text = strings.TrimFunc(text, func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' })
		if dashboardDecimal.MatchString(text) {
			n, _ = strconv.ParseFloat(text, 64)
		} else if len(text) > 2 && text[0] == '0' {
			base := 0
			switch text[1] {
			case 'x', 'X':
				base = 16
			case 'o', 'O':
				base = 8
			case 'b', 'B':
				base = 2
			}
			if base != 0 {
				v, err := strconv.ParseUint(text[2:], base, 64)
				if err == nil {
					n = float64(v)
				}
			}
		}
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, nil
	}
	return byte(int64(math.Mod(math.Trunc(n), 256))), nil
}

// Walk JavaScript UTF-16 units without allocating a rune slice or a second
// full-size UTF-16 copy of a potentially large upstream response.
func readmeUnits(text string, emit func(uint16) bool) {
	for _, r := range text {
		if r <= 0xffff {
			if !emit(uint16(r)) {
				return
			}
		} else {
			high, low := utf16.EncodeRune(r)
			if !emit(uint16(high)) || !emit(uint16(low)) {
				return
			}
		}
	}
}
