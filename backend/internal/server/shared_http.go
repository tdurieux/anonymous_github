package server

import (
	"compress/gzip"
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
)

var errSharedEncoding = errors.New("shared_encoding_not_acceptable")

type sharedResponse struct {
	accept, encoding string
	eligible         bool
	head             bool
}

func encodingWhitespace(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' }

// Match accepts/negotiator with the caller's offered encodings. Unlike the
// general compression middleware, this path has no Brotli/gzip preference list.
func sharedEncoding(header string, offered ...string) string {
	accepted := parseSharedEncodings(header)
	identity, minimum := false, float64(1)
	identityOrder := 0
	for _, entry := range accepted {
		identityOrder = max(identityOrder, entry.order+1)
		identity = identity || entry.name == "identity" || entry.name == "*"
		if entry.quality != 0 && !math.IsNaN(entry.quality) {
			minimum = math.Min(minimum, entry.quality)
		}
	}
	if !identity {
		accepted = append(accepted, encodingPreference{name: "identity", quality: minimum, order: identityOrder})
	}
	best := encodingPreference{order: -1, index: len(offered)}
	for i, name := range offered {
		priority := encodingPreference{name: name, order: -1, index: i}
		for _, a := range accepted {
			specificity := 0
			if strings.EqualFold(a.name, name) {
				specificity = 1
			} else if a.name != "*" {
				continue
			}
			diff := float64(priority.specificity - specificity)
			if diff == 0 {
				diff = priority.quality - a.quality
			}
			if diff == 0 || math.IsNaN(diff) {
				diff = float64(priority.order - a.order)
			}
			if diff < 0 {
				priority = encodingPreference{name: name, quality: a.quality, specificity: specificity, order: a.order, index: i}
			}
		}
		if priority.quality <= 0 || math.IsNaN(priority.quality) {
			continue
		}
		if best.quality == 0 || priority.quality > best.quality || priority.quality == best.quality && (priority.specificity > best.specificity || priority.specificity == best.specificity && (priority.order < best.order || priority.order == best.order && priority.index < best.index)) {
			best = priority
		}
	}
	return best.name
}

func sharedVary(h http.Header) {
	value := strings.Join(h.Values("Vary"), ", ")
	for _, field := range strings.Split(value, ",") {
		if strings.TrimSpace(field) == "*" || strings.EqualFold(strings.TrimSpace(field), "Accept-Encoding") {
			return
		}
	}
	if value != "" {
		value += ", "
	}
	h.Set("Vary", value+"Accept-Encoding")
}

// The bool reports whether body streaming started, distinguishing preparation
// errors from failures that must abort an already committed response.
func sendSharedBlob(ctx context.Context, w http.ResponseWriter, body *blobcache.Reader, response *sharedResponse) (bool, error) {
	record := body.Record()
	reader := body
	if record.Encoding == "gzip" && response.encoding == "gzip" {
		encoded, err := body.Reopen(ctx, true)
		if err != nil {
			return false, err
		}
		if encoded == nil {
			return false, fail("file_not_available", 502)
		}
		defer encoded.Close()
		reader = encoded
		record = encoded.Record()
	}
	h := w.Header()
	h.Set("Accept-Ranges", "none")
	if record.Encoding == "gzip" && response.encoding == "gzip" {
		h.Set("Content-Encoding", "gzip")
		h.Set("Content-Length", strconv.FormatInt(record.Stored, 10))
	} else {
		h.Del("Content-Encoding")
		h.Set("Content-Length", strconv.FormatInt(record.Size, 10))
	}
	if record.Encoding == "identity" && sharedEncoding(response.accept, "identity") == "" {
		h.Set("Content-Encoding", "gzip")
		h.Del("Content-Length")
		if response.head {
			w.WriteHeader(http.StatusOK)
			return true, nil
		}
		writer := gzip.NewWriter(w)
		_, err := io.Copy(writer, reader)
		closeErr := writer.Close()
		if err != nil {
			return true, err
		}
		return true, closeErr
	}
	if response.head {
		w.WriteHeader(http.StatusOK)
		return true, nil
	}
	_, err := io.Copy(w, reader)
	return true, err
}

// Parameter parsing follows the installed MIT-licensed content-type parser
// used by accepts/negotiator. See LICENSE.content-type and LICENSE.negotiator.
func parseSharedEncodings(header string) []encodingPreference {
	entries := []encodingPreference{}
	index, order := 0, 0
	skipOWS := func() {
		for index < len(header) && (header[index] == ' ' || header[index] == '\t') {
			index++
		}
	}
	skipValue := func() {
		for index < len(header) && header[index] != ';' && header[index] != ',' {
			index++
		}
	}
	for index < len(header) {
		skipOWS()
		start := index
		skipValue()
		name := strings.ToLower(strings.Trim(header[start:index], " \t"))
		params := map[string]string{}
	parameters:
		for index < len(header) && header[index] != ',' {
			index++
			skipOWS()
			keyStart := index
			for index < len(header) {
				switch header[index] {
				case ',':
					break parameters
				case ';':
					continue parameters
				case '=':
					key := strings.ToLower(strings.TrimRight(header[keyStart:index], " \t"))
					index++
					skipOWS()
					if index < len(header) && header[index] == '"' {
						index++
						var value strings.Builder
						for index < len(header) {
							ch := header[index]
							index++
							if ch == '"' {
								skipValue()
								if _, ok := params[key]; !ok {
									params[key] = value.String()
								}
								continue parameters
							}
							if ch == '\\' && index < len(header) {
								value.WriteByte(header[index])
								index++
								continue
							}
							value.WriteByte(ch)
						}
						continue parameters
					}
					valueStart := index
					skipValue()
					if _, ok := params[key]; !ok {
						params[key] = strings.TrimRight(header[valueStart:index], " \t")
					}
					continue parameters
				default:
					index++
				}
			}
		}
		if name != "" {
			quality := float64(1)
			if raw := params["q"]; raw != "" {
				quality = math.NaN()
				prefix := qualityPrefix.FindString(strings.TrimLeftFunc(raw, encodingWhitespace))
				switch prefix {
				case "Infinity", "+Infinity":
					quality = math.Inf(1)
				case "-Infinity":
					quality = math.Inf(-1)
				default:
					if prefix != "" {
						quality, _ = strconv.ParseFloat(prefix, 64)
					}
				}
			}
			entries = append(entries, encodingPreference{name: name, quality: quality, order: order})
		}
		index++
		order++
	}
	return entries
}
