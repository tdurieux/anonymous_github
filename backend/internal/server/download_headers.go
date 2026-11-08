package server

import "strings"

// downloadDisposition follows Express's installed content-disposition create
// path, including its ASCII fallback and UTF-8 extended filename. See
// LICENSE.content-disposition. The caller still validates storage paths.
func downloadDisposition(filename string) string {
	// POSIX basename, as used by the Node runtime. Unlike path.Base, an empty
	// filename remains empty and backslashes are ordinary filename characters.
	filename = strings.TrimRight(filename, "/")
	filename = filename[strings.LastIndexByte(filename, '/')+1:]
	extended := false
	var fallback strings.Builder
	for _, r := range filename {
		if r >= 0x20 && r <= 0x7e {
			fallback.WriteByte(byte(r))
		} else {
			extended = true
			fallback.WriteByte('?')
			// JavaScript's non-Unicode replacement regex sees UTF-16 code units.
			if r > 0xffff {
				fallback.WriteByte('?')
			}
		}
	}
	hex := func(b byte) bool { return b >= '0' && b <= '9' || b >= 'a' && b <= 'f' || b >= 'A' && b <= 'F' }
	for i := 0; i+2 < len(filename); i++ {
		if filename[i] == '%' && hex(filename[i+1]) && hex(filename[i+2]) {
			extended = true
			break
		}
	}
	result := "attachment; filename=" + dispositionParameter(fallback.String())
	if !extended {
		return result
	}
	var encoded strings.Builder
	const digits = "0123456789ABCDEF"
	for i := 0; i < len(filename); i++ {
		b := filename[i]
		if b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || strings.ContainsRune("!-._~", rune(b)) {
			encoded.WriteByte(b)
		} else {
			encoded.WriteByte('%')
			encoded.WriteByte(digits[b>>4])
			encoded.WriteByte(digits[b&15])
		}
	}
	return result + "; filename*=UTF-8''" + encoded.String()
}

func dispositionParameter(value string) string {
	token := len(value) > 0
	for i := 0; i < len(value); i++ {
		b := value[i]
		if !(b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", rune(b))) {
			token = false
			break
		}
	}
	if token {
		return value
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`
}
