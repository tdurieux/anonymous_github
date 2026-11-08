package anonymize

import "strings"

// regexp2's ECMAScript boundary still uses Unicode categories. JavaScript's
// boundary uses ASCII word characters, plus Kelvin sign/long s under /iu.
// Explicit case-sensitive assertions preserve that contract in fallback rules.
func javascriptBoundaries(pattern string, unicodeMode bool) string {
	word := `(?-i:[A-Za-z0-9_])`
	if unicodeMode {
		word = `(?-i:[A-Za-z0-9_Kſ])`
	}
	var out strings.Builder
	inClass := false
	for i := 0; i < len(pattern); i++ {
		b := pattern[i]
		if b == '\\' && i+1 < len(pattern) {
			i++
			next := pattern[i]
			if !inClass && (next == 'b' || next == 'B') {
				if next == 'b' {
					out.WriteString(`(?:(?<!` + word + `)(?=` + word + `)|(?<=` + word + `)(?!` + word + `))`)
				} else {
					out.WriteString(`(?:(?<!` + word + `)(?!` + word + `)|(?<=` + word + `)(?=` + word + `))`)
				}
			} else {
				out.WriteByte('\\')
				out.WriteByte(next)
			}
			continue
		}
		if b == '[' {
			inClass = true
		} else if b == ']' {
			inClass = false
		}
		out.WriteByte(b)
	}
	return out.String()
}
