// Response selection follows the MIT-licensed compression and negotiator packages.
// See LICENSE.compression and LICENSE.negotiator.
package server

import (
	"compress/gzip"
	"compress/zlib"
	"io"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/tdurieux/anonymous_github/backend/internal/filetype"
)

var compressionFilePath = regexp.MustCompile(`^/api/repo/.+/file/`)
var compressionNoTransform = regexp.MustCompile(`(?i)(?:^|,)\s*no-transform\s*(?:,|$)`)
var encodingToken = regexp.MustCompile(`^\s*([^\s;]+)\s*(?:;(.*))?$`)
var qualityPrefix = regexp.MustCompile(`^[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)`)

type encodingPreference struct {
	name                      string
	quality                   float64
	specificity, order, index int
}

func compressionEncoding(header string) string {
	if header == "" {
		return ""
	}
	accepted := []encodingPreference{}
	identity := false
	minimum := float64(1)
	fields := strings.Split(header, ",")
	for i, field := range fields {
		m := encodingToken.FindStringSubmatch(strings.TrimSpace(field))
		if m == nil {
			continue
		}
		q := float64(1)
		for _, param := range strings.Split(m[2], ";") {
			parts := strings.Split(strings.TrimSpace(param), "=")
			if parts[0] != "q" {
				continue
			}
			q = math.NaN()
			if len(parts) > 1 {
				prefix := qualityPrefix.FindString(strings.TrimSpace(parts[1]))
				if prefix == "Infinity" || prefix == "+Infinity" {
					q = math.Inf(1)
				} else if prefix == "-Infinity" {
					q = math.Inf(-1)
				} else if prefix != "" {
					q, _ = strconv.ParseFloat(prefix, 64)
				}
			}
			break
		}
		name := strings.ToLower(m[1])
		identity = identity || name == "identity" || name == "*"
		if q != 0 && !math.IsNaN(q) {
			minimum = math.Min(minimum, q)
		}
		accepted = append(accepted, encodingPreference{name: name, quality: q, order: i})
	}
	if !identity {
		accepted = append(accepted, encodingPreference{name: "identity", quality: minimum, order: len(fields)})
	}
	choices := []encodingPreference{}
	for index, name := range []string{"br", "gzip", "deflate", "identity"} {
		priority := encodingPreference{name: name, order: -1, index: index}
		for _, a := range accepted {
			specificity := 0
			if a.name == name {
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
				priority = encodingPreference{name: name, quality: a.quality, specificity: specificity, order: a.order, index: index}
			}
		}
		if priority.quality > 0 {
			choices = append(choices, priority)
		}
	}
	sort.SliceStable(choices, func(i, j int) bool {
		a, b := choices[i], choices[j]
		if a.quality != b.quality {
			return a.quality > b.quality
		}
		if a.index < 2 || b.index < 2 {
			return a.index < b.index
		}
		if a.specificity != b.specificity {
			return a.specificity > b.specificity
		}
		if a.order != b.order {
			return a.order < b.order
		}
		return a.index < b.index
	})
	if len(choices) == 0 || choices[0].name == "identity" {
		return ""
	}
	return choices[0].name
}

type compressionWriter struct {
	http.ResponseWriter
	request *http.Request
	encoder io.WriteCloser
	started bool
	status  int
	failure error
}

func (w *compressionWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *compressionWriter) WriteHeader(status int) {
	if status >= 100 && status < 200 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	if w.started {
		return
	}
	w.started = true
	w.status = status
	h := w.Header()
	if !compressionFilePath.MatchString(w.request.URL.Path) && filetype.Compressible(h.Get("Content-Type")) && !compressionNoTransform.MatchString(h.Get("Cache-Control")) {
		vary := strings.Join(h.Values("Vary"), ", ")
		present := false
		for _, field := range strings.Split(vary, ",") {
			if strings.TrimSpace(field) == "*" || strings.EqualFold(strings.TrimSpace(field), "Accept-Encoding") {
				present = true
			}
		}
		if !present {
			if vary != "" {
				vary += ", "
			}
			h.Set("Vary", vary+"Accept-Encoding")
		}
		length, err := strconv.ParseInt(h.Get("Content-Length"), 10, 64)
		encoding := h.Get("Content-Encoding")
		if (err != nil || length >= 1024) && (encoding == "" || encoding == "identity") && w.request.Method != "HEAD" {
			method := compressionEncoding(strings.Join(w.request.Header.Values("Accept-Encoding"), ", "))
			if method != "" {
				h.Set("Content-Encoding", method)
				h.Del("Content-Length")
				if status != 204 && status != 304 {
					switch method {
					case "gzip":
						w.encoder = gzip.NewWriter(w.ResponseWriter)
					case "deflate":
						w.encoder = zlib.NewWriter(w.ResponseWriter)
					case "br":
						w.encoder = brotli.NewWriterLevel(w.ResponseWriter, 4)
					}
				}
			}
		}
	}
	// Prevent net/http from inventing a compressed Content-Length after
	// buffering a small stream. Node commits these responses as chunked.
	if h.Get("Content-Length") == "" && status != 204 && status != 304 && w.request.Method != "HEAD" && w.request.ProtoMajor == 1 && w.request.ProtoMinor >= 1 {
		h.Set("Transfer-Encoding", "chunked")
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *compressionWriter) Write(data []byte) (int, error) {
	if err := w.request.Context().Err(); err != nil {
		w.failure = err
		return 0, err
	}
	if !w.started {
		w.WriteHeader(http.StatusOK)
	}
	if w.failure != nil {
		return 0, w.failure
	}
	if w.status == http.StatusNoContent || w.status == http.StatusNotModified {
		return 0, http.ErrBodyNotAllowed
	}
	if w.encoder != nil {
		n, err := w.encoder.Write(data)
		w.failure = err
		return n, err
	}
	n, err := w.ResponseWriter.Write(data)
	w.failure = err
	return n, err
}
func (w *compressionWriter) Flush() {
	if err := w.request.Context().Err(); err != nil {
		w.failure = err
		return
	}
	if !w.started {
		w.WriteHeader(http.StatusOK)
	}
	if encoder, ok := w.encoder.(interface{ Flush() error }); ok {
		if err := encoder.Flush(); err != nil {
			w.failure = err
			return
		}
	}
	if err := http.NewResponseController(w.ResponseWriter).Flush(); err != nil {
		w.failure = err
	}
}
func (w *compressionWriter) finish() error {
	if err := w.request.Context().Err(); err != nil {
		return err
	}
	if w.failure != nil {
		return w.failure
	}
	if w.encoder != nil {
		return w.encoder.Close()
	}
	return nil
}

// Redirect responses are complete small bodies, not unknown-length streams.
// Defer their status until http.Redirect supplies the encoded body length.
type redirectLengthWriter struct {
	http.ResponseWriter
	status          int
	committed, head bool
}

func (w *redirectLengthWriter) WriteHeader(status int) {
	if !w.committed {
		w.status = status
	}
}
func (w *redirectLengthWriter) Write(data []byte) (int, error) {
	if !w.committed {
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.ResponseWriter.WriteHeader(w.status)
		w.committed = true
	}
	if w.head {
		return len(data), nil
	}
	return w.ResponseWriter.Write(data)
}
func redirectKnownLength(w http.ResponseWriter, r *http.Request, target string, status int) {
	deferred := &redirectLengthWriter{ResponseWriter: w, status: status, head: r.Method == http.MethodHead}
	if deferred.head {
		r = r.Clone(r.Context())
		r.Method = http.MethodGet
	}
	http.Redirect(deferred, r, target, status)
	if !deferred.committed {
		deferred.Header().Set("Content-Length", "0")
		deferred.ResponseWriter.WriteHeader(deferred.status)
	}
}
