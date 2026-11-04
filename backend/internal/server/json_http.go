package server

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// ETag and freshness rules follow the MIT-licensed etag and fresh packages.
// See LICENSE.etag and LICENSE.fresh.
func entityTag(body []byte) string {
	digest := sha1.Sum(body)
	return fmt.Sprintf(`"%x-%s"`, len(body), base64.RawStdEncoding.EncodeToString(digest[:]))
}

var requestNoCache = regexp.MustCompile(`(?:^|,)\s*no-cache\s*(?:,|$)`)

func responseFresh(r *http.Request, status int, header http.Header) bool {
	if r.Method != "GET" && r.Method != "HEAD" && r.Method != "QUERY" {
		return false
	}
	if !(status >= 200 && status < 300 || status == 304) {
		return false
	}
	if requestNoCache.MatchString(strings.Join(r.Header.Values("Cache-Control"), ", ")) {
		return false
	}
	match := strings.Join(r.Header.Values("If-None-Match"), ", ")
	if match != "" {
		if match == "*" {
			return true
		}
		tag := header.Get("ETag")
		if tag == "" {
			return false
		}
		for _, token := range strings.Split(match, ",") {
			token = strings.Trim(token, " ")
			if token == tag || token == "W/"+tag || "W/"+token == tag {
				return true
			}
		}
		return false
	}
	if since := r.Header.Get("If-Modified-Since"); since != "" {
		modified, ok := responseHTTPDate(header.Get("Last-Modified"))
		limit, valid := responseHTTPDate(since)
		return ok && valid && !modified.After(limit)
	}
	return false
}
func responseHTTPDate(value string) (time.Time, bool) {
	if parsed, err := http.ParseTime(value); err == nil {
		return parsed, true
	}
	parsed := date(value)
	return parsed, !parsed.IsZero()
}
func responseRequest(w http.ResponseWriter) *http.Request {
	for i := 0; i < 16; i++ {
		if compressed, ok := w.(*compressionWriter); ok {
			return compressed.request
		}
		if wrapped, ok := w.(interface{ Unwrap() http.ResponseWriter }); ok {
			w = wrapped.Unwrap()
		} else {
			break
		}
	}
	return nil
}

type jsonEntityWriter struct {
	writer  http.ResponseWriter
	status  int
	started bool
}

func (w *jsonEntityWriter) Write(encoded []byte) (int, error) {
	w.started = true
	body := bytes.TrimSuffix(encoded, []byte("\n"))
	body = jsonSeparators(body)
	header := w.writer.Header()
	if header.Get("ETag") == "" {
		header.Set("ETag", entityTag(body))
	}
	status := w.status
	if status == 0 {
		status = 200
	}
	request := responseRequest(w.writer)
	if request != nil && responseFresh(request, status, header) {
		status = 304
	}
	header.Set("Content-Length", fmt.Sprint(len(body)))
	if status == 204 || status == 304 {
		header.Del("Content-Type")
		header.Del("Content-Length")
		header.Del("Transfer-Encoding")
		w.writer.WriteHeader(status)
		return len(encoded), nil
	}
	if status == 205 {
		header.Set("Content-Length", "0")
		header.Del("Transfer-Encoding")
		w.writer.WriteHeader(status)
		return len(encoded), nil
	}
	w.writer.WriteHeader(status)
	if request != nil && request.Method == "HEAD" {
		return len(encoded), nil
	}
	n, err := w.writer.Write(body)
	if err == nil && n == len(body) {
		return len(encoded), nil
	}
	return n, err
}

// JSON.stringify leaves U+2028/U+2029 literal. Skip complete escape pairs so a
// literal backslash followed by "u2028" remains a literal string, not a rune.
func jsonSeparators(data []byte) []byte {
	if !bytes.Contains(data, []byte(`\u202`)) {
		return data
	}
	out := make([]byte, 0, len(data))
	for i := 0; i < len(data); i++ {
		if data[i] == '\\' && i+1 < len(data) {
			if i+5 < len(data) && (string(data[i:i+6]) == `\u2028` || string(data[i:i+6]) == `\u2029`) {
				if data[i+5] == '8' {
					out = append(out, []byte("\u2028")...)
				} else {
					out = append(out, []byte("\u2029")...)
				}
				i += 5
				continue
			}
			out = append(out, data[i], data[i+1])
			i++
			continue
		}
		out = append(out, data[i])
	}
	return out
}
