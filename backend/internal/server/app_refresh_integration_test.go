package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAppRefreshIntegration(t *testing.T, s *Server) {
	t.Run("App token refresh coordination", func(t *testing.T) {
		ctx := context.Background()
		oldHTTP, enabled := s.HTTP, s.Config.AppEnabled
		s.Config.AppEnabled = true
		defer func() { s.HTTP = oldHTTP; s.Config.AppEnabled = enabled }()
		q := &request{Server: s, R: httptest.NewRequest("GET", "/github/app/callback", nil)}
		tokens := func(access, refresh string) M {
			return M{"access_token": access, "refresh_token": refresh, "expires_in": float64(3600), "refresh_token_expires_in": float64(7200)}
		}
		seed := func() bson.ObjectID {
			t.Helper()
			owner := bson.NewObjectID()
			if _, err := s.Store.DB.Collection("users").InsertOne(ctx, M{"_id": owner, "username": "refresh-" + owner.Hex(), "status": "active"}); err != nil {
				t.Fatal(err)
			}
			if err := s.saveGrant(q, owner, "github-app-user", tokens("seed-access", "seed-refresh")); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Store.update(ctx, "credentials", M{"ownerId": owner, "provider": "github-app-user"}, M{"$set": M{"expiresAt": time.Now().Add(-time.Minute)}}); err != nil {
				t.Fatal(err)
			}
			return owner
		}
		load := func(owner bson.ObjectID) M {
			t.Helper()
			row, err := s.Store.one(ctx, "credentials", M{"ownerId": owner, "provider": "github-app-user"})
			if err != nil {
				t.Fatal(err)
			}
			return row
		}
		configure := func(hook func(*http.Request) error) *atomic.Int64 {
			count := &atomic.Int64{}
			s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
				count.Add(1)
				if deadline, ok := r.Context().Deadline(); !ok || time.Until(deadline) > 20*time.Second {
					t.Error("token exchange has no bounded deadline")
				}
				var body M
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					return nil, err
				}
				if body["grant_type"] != "refresh_token" || body["refresh_token"] != "seed-refresh" {
					t.Error("unexpected refresh request")
				}
				if hook != nil {
					if err := hook(r); err != nil {
						return nil, err
					}
				}
				raw, _ := json.Marshal(tokens("rotated-access", "rotated-refresh"))
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
			})}
			return count
		}
		t.Run("concurrent callers rotate once", func(t *testing.T) {
			owner := seed()
			count := configure(func(*http.Request) error { time.Sleep(30 * time.Millisecond); return nil })
			var group sync.WaitGroup
			results := make(chan string, 8)
			failures := make(chan error, 8)
			for i := 0; i < 8; i++ {
				group.Add(1)
				go func() {
					defer group.Done()
					value, err := s.credential(ctx, owner, "github-app-user")
					results <- value
					failures <- err
				}()
			}
			group.Wait()
			close(results)
			close(failures)
			for err := range failures {
				if err != nil {
					t.Fatal(err)
				}
			}
			for value := range results {
				if value != "rotated-access" {
					t.Fatal("unexpected access token")
				}
			}
			if count.Load() != 1 {
				t.Fatal("duplicate refresh", count.Load())
			}
			row := load(owner)
			if row["refreshLock"] != nil || row["refreshLockUntil"] != nil {
				t.Fatal("refresh lock retained")
			}
			encrypted, err := envelope(row["encryptedRefreshToken"])
			if err != nil {
				t.Fatal(err)
			}
			value, err := s.Config.Cipher.Decrypt(encrypted, owner.Hex(), "github-app-user", "encryptedRefreshToken")
			if err != nil || value != "rotated-refresh" {
				t.Fatal("refresh credential did not rotate", err)
			}
		})
		t.Run("revocation wins over an in-flight refresh", func(t *testing.T) {
			owner := seed()
			configure(func(*http.Request) error {
				_, err := s.Store.update(ctx, "credentials", M{"ownerId": owner, "provider": "github-app-user"}, M{"$set": M{"revoked": true, "revision": "revoked-during-refresh"}})
				return err
			})
			value, err := s.credential(ctx, owner, "github-app-user")
			if err == nil || value != "" {
				t.Fatal("revoked token returned")
			}
			row := load(owner)
			if !boolean(row["revoked"]) || row["revision"] != "revoked-during-refresh" || row["refreshLock"] != nil {
				t.Fatal("refresh revived revoked grant")
			}
		})
		t.Run("new login wins over an in-flight refresh", func(t *testing.T) {
			owner := seed()
			configure(func(*http.Request) error {
				return s.saveGrant(q, owner, "github-app-user", tokens("new-login-access", "new-login-refresh"))
			})
			value, err := s.credential(ctx, owner, "github-app-user")
			if err != nil || value != "new-login-access" {
				t.Fatal("refresh overwrote newer login", err)
			}
		})
		for _, replacement := range []bool{false, true} {
			name := "cancel releases own lock"
			if replacement {
				name = "cancel preserves replacement lock"
			}
			t.Run(name, func(t *testing.T) {
				owner := seed()
				work, cancel := context.WithCancel(ctx)
				defer cancel()
				configure(func(r *http.Request) error {
					if replacement {
						if _, err := s.Store.update(ctx, "credentials", M{"ownerId": owner, "provider": "github-app-user"}, M{"$set": M{"refreshLock": "replacement-lock", "refreshLockUntil": time.Now().Add(time.Minute)}}); err != nil {
							return err
						}
					}
					cancel()
					return r.Context().Err()
				})
				if _, err := s.credential(work, owner, "github-app-user"); err == nil {
					t.Fatal("cancelled exchange succeeded")
				}
				row := load(owner)
				if replacement {
					if row["refreshLock"] != "replacement-lock" {
						t.Fatal("replacement lock removed")
					}
				} else {
					if row["refreshLock"] != nil || row["refreshLockUntil"] != nil {
						t.Fatal("cancelled refresh retained lock")
					}
					configure(nil)
					if value, err := s.credential(ctx, owner, "github-app-user"); err != nil || value != "rotated-access" {
						t.Fatal("cancel prevented immediate retry", err)
					}
				}
			})
		}
	})
}
