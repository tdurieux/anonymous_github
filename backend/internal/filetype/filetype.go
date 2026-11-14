// Package filetype preserves the Node backend's MIME and binary-sniffing rules.
// MIME data is generated from mime-types; see LICENSE.mime-db. The bounded
// binary heuristic follows isbinaryfile; see LICENSE.isbinaryfile.
package filetype

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"path"
	"strings"
)

//go:embed mime.json
var mimeData []byte
var types map[string]string

func init() {
	if e := json.Unmarshal(mimeData, &types); e != nil {
		panic(e)
	}
}
func MIME(ext string) string { return types[strings.ToLower(strings.TrimPrefix(ext, "."))] }

var names = map[string]bool{"license": true, "licence": true, "copying": true, "copyright": true, "authors": true, "contributors": true, "readme": true, "changelog": true, "changes": true, "notice": true, "install": true, "todo": true, "version": true, "manifest": true}
var additional = map[string]bool{"license": true, "dockerfile": true, "sbt": true, "ipynb": true, "gp": true, "out": true, "sol": true, "in": true, "jsonl": true, "ndjson": true, "bat": true, "cmd": true, "ts": true}
var textual = map[string]bool{"application/json": true, "application/ld+json": true, "application/xml": true, "application/javascript": true, "application/ecmascript": true, "application/typescript": true, "application/toml": true, "application/sql": true, "application/x-sql": true, "application/x-sh": true, "application/x-csh": true, "application/x-yaml": true, "application/yaml": true, "application/x-httpd-php": true, "application/graphql": true, "application/x-tex": true, "application/x-latex": true, "application/x-perl": true, "application/x-ruby": true, "application/x-python": true}

func ClassifyName(name string) (bool, bool) {
	base := strings.ToLower(path.Base(name))
	parts := strings.Split(base, ".")
	ext := parts[len(parts)-1]
	if names[base] || additional[ext] {
		return true, true
	}
	mime := strings.Split(MIME(path.Ext(base)), ";")[0]
	if mime != "" {
		return strings.HasPrefix(mime, "text/") || textual[mime] || strings.HasSuffix(mime, "+json") || strings.HasSuffix(mime, "+xml") || strings.HasSuffix(mime, "+yaml"), true
	}
	return false, false
}
func Text(name string, data []byte) bool {
	if text, known := ClassifyName(name); known {
		return text
	}
	return len(data) > 0 && !binary(data)
}

func binary(data []byte) bool {
	if len(data) == 0 {
		return false
	}
	for _, bom := range [][]byte{{0xef, 0xbb, 0xbf}, {0, 0, 0xfe, 0xff}, {0xff, 0xfe, 0, 0}, {0x84, 0x31, 0x95, 0x33}, {0xfe, 0xff}, {0xff, 0xfe}} {
		if bytes.HasPrefix(data, bom) {
			return false
		}
	}
	if bytes.HasPrefix(data, []byte("%PDF-")) {
		return true
	}
	total := min(len(data), 515)
	scan := min(total, 512)
	suspicious := 0
	continuation := func(b byte) bool { return b >= 0x80 && b <= 0xbf }
	for i := 0; i < scan; i++ {
		b := data[i]
		if b == 0 {
			return true
		}
		if (b < 7 || b > 14) && (b < 32 || b > 127) {
			if b >= 0xc0 && b <= 0xdf && i+1 < total {
				i++
				if continuation(data[i]) {
					continue
				}
			} else if b >= 0xe0 && b <= 0xef && i+2 < total {
				i++
				if continuation(data[i]) && continuation(data[i+1]) {
					i++
					continue
				}
			} else if b >= 0xf0 && b <= 0xf7 && i+3 < total {
				i++
				if continuation(data[i]) && continuation(data[i+1]) && continuation(data[i+2]) {
					i += 2
					continue
				}
			}
			suspicious++
			if i >= 32 && suspicious*100 > scan*10 {
				return true
			}
		}
	}
	if suspicious*100 > scan*10 {
		return true
	}
	return suspicious > 1 && protobuf(data[:scan])
}
func protobuf(data []byte) bool {
	offset := 0
	broken := false
	count := 0
	next := func() byte {
		if offset >= len(data) || broken {
			broken = true
			return 0xff
		}
		b := data[offset]
		offset++
		return b
	}
	variable := func() int32 {
		var value int32
		for i := 0; !broken; i++ {
			b := next()
			value |= int32(b&0x7f) << ((7 * i) % 32)
			if b&0x80 == 0 {
				break
			}
			if i >= 10 {
				broken = true
				break
			}
		}
		return value
	}
	for !broken {
		tag := variable()
		length := int32(0)
		valid := true
		switch tag & 7 {
		case 0:
			variable()
		case 1:
			length = 8
		case 2:
			length = variable()
		case 5:
			length = 4
		default:
			valid = false
		}
		if !valid && !broken {
			return false
		}
		if length > 0 {
			if int64(offset)+int64(length) > int64(len(data)) {
				broken = true
			} else {
				offset += int(length)
			}
		}
		if !broken {
			count++
		}
	}
	return count > 0
}
