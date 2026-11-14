package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

type reviewKey struct {
	digest      []byte
	from, until time.Time
}
type reviewRate struct {
	minute int64
	count  int
}
type reviewRegistry struct {
	keys  map[string]reviewKey
	mu    sync.Mutex
	rates map[string]reviewRate
}

var reviewClient = regexp.MustCompile(`^[a-f0-9]{32}$`)
var reviewKeyID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var reviewSecret = regexp.MustCompile(`^[a-f0-9]{64}$`)

func parseReviewRegistry(raw *string) (*reviewRegistry, error) {
	if raw == nil {
		return nil, nil
	}
	invalid := errors.New("invalid_REVIEW_SERVICE_KEYS")
	var config M
	if len(*raw) > 65536 || json.Unmarshal([]byte(*raw), &config) != nil || len(config) != 2 || config["version"] != float64(1) {
		return nil, invalid
	}
	entries, ok := config["keys"].([]any)
	if !ok || len(entries) < 1 || len(entries) > 64 {
		return nil, invalid
	}
	registry := &reviewRegistry{keys: map[string]reviewKey{}, rates: map[string]reviewRate{}}
	clients, digests := map[string]int{}, map[string]bool{}
	for _, entry := range entries {
		key := obj(entry)
		client, id, digest := str(key["clientId"]), str(key["keyId"]), str(key["tokenSHA256"])
		if len(key) != 5 || !reviewClient.MatchString(client) || !reviewKeyID.MatchString(id) || !reviewSecret.MatchString(digest) {
			return nil, invalid
		}
		dates := []time.Time{}
		for _, field := range []string{"notBefore", "notAfter"} {
			value := str(key[field])
			parsed, err := time.Parse("2006-01-02T15:04:05Z", value)
			if err != nil || !strings.HasPrefix(value, "20") || parsed.Format("2006-01-02T15:04:05Z") != value {
				return nil, invalid
			}
			dates = append(dates, parsed)
		}
		name := client + ":" + id
		_, exists := registry.keys[name]
		clients[client]++
		if exists || digests[digest] || clients[client] > 16 || len(clients) > 32 || !dates[1].After(dates[0]) {
			return nil, invalid
		}
		decoded, _ := hex.DecodeString(digest)
		registry.keys[name] = reviewKey{decoded, dates[0], dates[1]}
		digests[digest] = true
	}
	return registry, nil
}
func (s *Server) reviewCapabilities(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	reject := func(status int, code string, retry int) {
		w.Header().Set("Connection", "close")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		out := M{"contract": "4open.artifacts/1", "code": code, "requestId": strings.ReplaceAll(uuid.NewString(), "-", "")}
		if retry > 0 {
			w.Header().Set("Retry-After", fmt.Sprint(retry))
			out["retryAfterSeconds"] = retry
		}
		w.WriteHeader(status)
		writeJSON(w, out)
	}
	if s.review == nil || r.URL.RequestURI() != "/service/v1/capabilities" {
		reject(404, "not-found", 0)
		return
	}
	if r.Method != "GET" {
		reject(405, "invalid-request", 0)
		return
	}
	for _, h := range []string{"Cookie", "Origin", "Referer", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User"} {
		if _, ok := r.Header[http.CanonicalHeaderKey(h)]; ok {
			reject(403, "forbidden", 0)
			return
		}
	}
	_, hasContentType := r.Header["Content-Type"]
	if len(r.TransferEncoding) > 0 || hasContentType || r.ContentLength > 0 || (r.Header.Get("Content-Length") != "" && r.Header.Get("Content-Length") != "0") {
		reject(400, "invalid-request", 0)
		return
	}
	single := func(name string) string {
		values := r.Header.Values(name)
		if len(values) != 1 {
			return ""
		}
		return values[0]
	}
	client, keyID, auth := single("X-4open-artifact-client-id"), single("X-4open-artifact-service-key-id"), single("Authorization")
	if !reviewClient.MatchString(client) || !reviewKeyID.MatchString(keyID) || len(auth) != 71 || !strings.EqualFold(auth[:7], "Bearer ") || !reviewSecret.MatchString(auth[7:]) {
		reject(401, "unauthorized", 0)
		return
	}
	key, exists := s.review.keys[client+":"+keyID]
	expected := key.digest
	if !exists {
		expected = make([]byte, 32)
	}
	digest := sha256.Sum256([]byte(auth[7:]))
	equal := subtle.ConstantTimeCompare(digest[:], expected)
	now := time.Now()
	if !exists || equal != 1 || now.Before(key.from) || !now.Before(key.until) {
		reject(401, "unauthorized", 0)
		return
	}
	s.review.mu.Lock()
	minute := now.Unix() / 60
	rate := s.review.rates[client]
	if rate.minute != minute {
		rate = reviewRate{minute: minute}
	}
	limited := rate.count >= 60
	if !limited {
		rate.count++
		s.review.rates[client] = rate
	}
	s.review.mu.Unlock()
	if limited {
		reject(429, "rate-limited", 60-int(now.Unix()%60))
		return
	}
	writeJSON(w, M{"contract": "4open.artifacts/1", "clientId": client, "contracts": []string{"4open.artifacts/1"}, "available": []string{}})
}
func reviewConsentPath(path string) bool {
	return strings.TrimRight(strings.ToLower(path), "/") == "/review-link"
}
func (s *Server) reviewConsentPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
	if r.URL.RequestURI() != "/review-link" || (r.Method != "GET" && r.Method != "HEAD") {
		writeError(w, fail("not_found", 404))
		return
	}
	manifest := map[string]string{}
	if data, err := s.public.ReadFile("asset-manifest.json"); err == nil {
		_ = json.Unmarshal(data, &manifest)
	}
	asset := func(name string) string {
		value := manifest[name]
		extension := ".js"
		if strings.HasSuffix(name, ".css") {
			extension = ".css"
		}
		if !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`).MatchString(value) || !strings.HasSuffix(value, extension) {
			return name
		}
		return value
	}
	page := fmt.Sprintf(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="review-consent-page" content="1"><title>Artifact consent · Anonymous GitHub</title><link rel="stylesheet" href="/css/%s"></head><body><div id="app"></div><script src="/script/%s"></script><script defer src="/script/%s"></script></body></html>`, asset("all.min.css"), asset("core.min.js"), asset("vendor.min.js"))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(page)))
	if r.Method != "HEAD" {
		_, _ = w.Write([]byte(page))
	}
}
