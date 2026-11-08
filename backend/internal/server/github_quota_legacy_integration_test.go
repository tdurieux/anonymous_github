package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runLegacyGitHubQuotaIntegration(t *testing.T, base *Server) {
	t.Run("TypeScript quota records survive Go cutover", func(t *testing.T) {
		ctx := context.Background()
		raw, err := os.ReadFile("testdata/github-quota.json")
		if err != nil {
			t.Fatal(err)
		}
		var cases []struct {
			Name, Token, Scope string
			Expected           []string
		}
		if err := json.Unmarshal(raw, &cases); err != nil {
			t.Fatal(err)
		}
		for _, c := range cases {
			t.Run(c.Name, func(t *testing.T) {
				var calls atomic.Int64
				client := &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) {
					calls.Add(1)
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
				})}
				s := &Server{Store: base.Store, HTTP: client}
				if c.Scope != "" {
					s.registerGitHubQuota(c.Token, c.Scope)
				}
				now := time.Now().Truncate(time.Millisecond)
				reset := now.Add(time.Hour)
				defer base.Store.Redis.Del(ctx, c.Expected...)
				for i, key := range c.Expected {
					until := reset.Add(-time.Duration(len(c.Expected)-1-i) * time.Minute)
					if err := base.Store.Redis.Set(ctx, key, strconv.FormatInt(until.UnixMilli(), 10), 2*time.Hour).Err(); err != nil {
						t.Fatal(err)
					}
				}
				_, err := s.github(ctx, "GET", "/user", c.Token, nil)
				var api *APIError
				if !errors.As(err, &api) || api.ResetAt != reset.UnixMilli() || calls.Load() != 0 {
					t.Fatal("legacy gate bypassed", err, calls.Load())
				}
				for i, key := range c.Expected {
					want := strconv.FormatInt(reset.Add(-time.Duration(len(c.Expected)-1-i)*time.Minute).UnixMilli(), 10)
					got, err := base.Store.Redis.Get(ctx, key).Result()
					if err != nil || got != want {
						t.Fatal("legacy value changed", got, err)
					}
					ttl, err := base.Store.Redis.PTTL(ctx, key).Result()
					if err != nil || ttl <= 0 || ttl > 2*time.Hour {
						t.Fatal("legacy expiry changed", ttl, err)
					}
				}
				// Deleting the old runtime's records cannot discard the imported gate.
				if err := base.Store.Redis.Del(ctx, c.Expected...).Err(); err != nil {
					t.Fatal(err)
				}
				next := &Server{Store: base.Store, HTTP: client}
				token := c.Token
				if c.Scope != "" {
					token += "-renewed"
					next.registerGitHubQuota(token, c.Scope)
				}
				_, err = next.github(ctx, "GET", "/user", token, nil)
				if !errors.As(err, &api) || api.ResetAt != reset.UnixMilli() || calls.Load() != 0 {
					t.Fatal("import lost across instances/renewal", err)
				}
				// A stale legacy delay cannot shorten a newer Go gate.
				longer := reset.Add(time.Hour)
				if err := next.quotaGate().Extend(ctx, "github", next.githubQuotaScope(token), longer); err != nil {
					t.Fatal(err)
				}
				legacyKey := legacyGitHubQuotaKeys(token, next.githubQuotaScope(token))[0]
				defer base.Store.Redis.Del(ctx, legacyKey)
				if err := base.Store.Redis.Set(ctx, legacyKey, strconv.FormatInt(reset.UnixMilli(), 10), time.Hour).Err(); err != nil {
					t.Fatal(err)
				}
				err = next.checkGitHubQuota(ctx, token)
				if !errors.As(err, &api) || api.ResetAt != longer.UnixMilli() {
					t.Fatal("legacy record shortened Go gate", err)
				}
				// Later Node activity extends the imported Go gate without resetting it.
				latest := longer.Add(time.Hour)
				if err := base.Store.Redis.Set(ctx, legacyKey, strconv.FormatInt(latest.UnixMilli(), 10), time.Hour).Err(); err != nil {
					t.Fatal(err)
				}
				err = next.checkGitHubQuota(ctx, token)
				if !errors.As(err, &api) || api.ResetAt != latest.UnixMilli() {
					t.Fatal("new legacy extension ignored", err)
				}
			})
		}
	})
	t.Run("expired and malformed legacy quotas do not block requests", func(t *testing.T) {
		ctx := context.Background()
		for _, value := range []string{"0", "-1", "1", "NaN", "9223372036854775807", "1800000000123junk", "1800000000123.5"} {
			token := "synthetic-invalid-" + bson.NewObjectID().Hex()
			s := &Server{Store: base.Store}
			key := legacyGitHubQuotaKeys(token, s.githubQuotaScope(token))[0]
			defer base.Store.Redis.Del(ctx, key)
			if err := base.Store.Redis.Set(ctx, key, value, time.Minute).Err(); err != nil {
				t.Fatal(err)
			}
			if err := s.checkGitHubQuota(ctx, token); err != nil {
				t.Fatal("invalid legacy gate blocked credential", value, err)
			}
		}
		token := "synthetic-expiring-" + bson.NewObjectID().Hex()
		s := &Server{Store: base.Store}
		key := legacyGitHubQuotaKeys(token, s.githubQuotaScope(token))[0]
		defer base.Store.Redis.Del(ctx, key)
		until := time.Now().Add(100 * time.Millisecond)
		if err := base.Store.Redis.Set(ctx, key, strconv.FormatInt(until.UnixMilli(), 10), time.Minute).Err(); err != nil {
			t.Fatal(err)
		}
		if err := s.checkGitHubQuota(ctx, token); err == nil {
			t.Fatal("active legacy record ignored")
		}
		time.Sleep(150 * time.Millisecond)
		if err := s.checkGitHubQuota(ctx, token); err != nil {
			t.Fatal("expired legacy record revived", err)
		}
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		if err := s.checkGitHubQuota(canceled, token); !errors.Is(err, context.Canceled) {
			t.Fatal("cancellation ignored", err)
		}
	})
}
