package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/quotagate"
)

func tokenDigest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (s *Server) registerGitHubQuota(token, scope string) {
	if token == "" {
		return
	}
	s.quotaMu.Lock()
	defer s.quotaMu.Unlock()
	if s.quotaScopes == nil {
		s.quotaScopes = map[string]string{}
	}
	if len(s.quotaScopes) >= 2048 {
		for k := range s.quotaScopes {
			delete(s.quotaScopes, k)
			break
		}
	}
	s.quotaScopes[tokenDigest(token)] = scope
}
func (s *Server) githubQuotaScope(token string) string {
	digest := tokenDigest(token)
	s.quotaMu.Lock()
	scope := s.quotaScopes[digest]
	s.quotaMu.Unlock()
	if scope != "" {
		return scope
	}
	return "token:" + digest
}
func (s *Server) quotaGate() *quotagate.Gate {
	s.quotaOnce.Do(func() {
		if s.Store != nil && s.Store.Redis != nil {
			s.providerQuota = quotagate.New(s.Store.Redis.WithTimeout(250 * time.Millisecond))
		} else {
			s.providerQuota = quotagate.New(nil)
		}
	})
	return s.providerQuota
}
func (s *Server) checkGitHubQuota(ctx context.Context, token string) error {
	scope := s.githubQuotaScope(token)
	reset, err := s.quotaGate().Current(ctx, "github", scope)
	if err != nil {
		return err
	}
	// Import on use rather than scanning Redis or decrypting every stored
	// credential at cutover. Legacy records remain untouched for rollback.
	if s.Store != nil && s.Store.Redis != nil {
		values, _ := s.Store.Redis.WithTimeout(250*time.Millisecond).MGet(ctx, legacyGitHubQuotaKeys(token, scope)...).Result()
		latest := reset
		for _, value := range values {
			text, ok := value.(string)
			if !ok {
				continue
			}
			millis, err := strconv.ParseInt(text, 10, 64)
			if err != nil || millis <= 0 || millis > 253402300799000 {
				continue
			}
			candidate := time.UnixMilli(millis)
			if candidate.After(time.Now()) && candidate.After(latest) {
				latest = candidate
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if latest.After(reset) {
			if err := s.quotaGate().Extend(ctx, "github", scope, latest); err != nil {
				return err
			}
			// Another Go instance may have extended the same scope meanwhile.
			reset, err = s.quotaGate().Current(ctx, "github", scope)
			if err != nil {
				return err
			}
			if reset.Before(latest) {
				reset = latest
			}
		}
	}
	if reset.After(time.Now()) {
		return &APIError{Code: "github_rate_limit_exceeded", Status: 429, ResetAt: reset.UnixMilli()}
	}
	return nil
}

// TypeScript's process-local token contexts use stable installation/App-user
// keys; unregistered tokens use the first 24 hex characters of SHA-256. Read
// both because the old process may have used a token before registering it.
func legacyGitHubQuotaKeys(token, scope string) []string {
	keys := []string{"gh_rate_gate:" + tokenDigest(token)[:24]}
	if strings.HasPrefix(scope, "app-user:") {
		if _, err := oid(strings.TrimPrefix(scope, "app-user:")); err == nil {
			keys = append(keys, "gh_rate_gate:"+scope)
		}
	} else if strings.HasPrefix(scope, "installation:") {
		parts := strings.Split(scope, ":")
		if len(parts) == 3 {
			id, err := strconv.ParseInt(parts[2], 10, 64)
			if err == nil && id > 0 && strconv.FormatInt(id, 10) == parts[2] {
				keys = append(keys, "gh_rate_gate:installation:"+parts[2])
			}
		}
	}
	return keys
}
func (s *Server) recordGitHubQuota(ctx context.Context, token string, h http.Header) error {
	limited := githubRateLimit(h, time.Now()).(*APIError)
	_ = s.quotaGate().Extend(ctx, "github", s.githubQuotaScope(token), time.UnixMilli(limited.ResetAt))
	return limited
}
func githubLimited(response *http.Response) bool {
	_, retry := response.Header[http.CanonicalHeaderKey("Retry-After")]
	return response.StatusCode == 429 || (response.StatusCode == 403 && (response.Header.Get("X-RateLimit-Remaining") == "0" || retry))
}
