// Package quotagate coordinates provider quotas across processes. Scope names
// belong to adapters: use a stable installation/account identifier where token
// renewal shares a quota, or the token itself for an independent credential.
package quotagate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const maxLocal = 2048

type Gate struct {
	client redis.UniversalClient
	mu     sync.Mutex
	local  map[string]int64
}

func New(client redis.UniversalClient) *Gate {
	return &Gate{client: client, local: make(map[string]int64)}
}

func key(provider, scope string) string {
	input, _ := json.Marshal([]string{provider, scope})
	digest := sha256.Sum256(input)
	return "go:provider-quota:" + hex.EncodeToString(digest[:])
}

func (g *Gate) remember(key string, reset, now int64) int64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	if reset > 253402300799000 {
		reset = 0
	}
	if previous := g.local[key]; previous > reset {
		reset = previous
	}
	if reset <= now {
		delete(g.local, key)
		return 0
	}
	if _, exists := g.local[key]; !exists && len(g.local) >= maxLocal {
		for k, v := range g.local {
			if v <= now {
				delete(g.local, k)
			}
		}
		if len(g.local) >= maxLocal {
			for k := range g.local {
				delete(g.local, k)
				break
			}
		}
	}
	g.local[key] = reset
	return reset
}

// Current returns zero when unrestricted. Redis outages fail open for unknown
// scopes, while already observed limits remain in the bounded local fallback.
// Cancellation is returned to the caller rather than permitting upstream work.
func (g *Gate) Current(ctx context.Context, provider, scope string) (time.Time, error) {
	if err := ctx.Err(); err != nil {
		return time.Time{}, err
	}
	k := key(provider, scope)
	var reset int64
	if g.client != nil {
		reset, _ = g.client.Get(ctx, k).Int64()
	}
	if err := ctx.Err(); err != nil {
		return time.Time{}, err
	}
	reset = g.remember(k, reset, time.Now().UnixMilli())
	if reset == 0 {
		return time.Time{}, nil
	}
	return time.UnixMilli(reset), nil
}

// Updating a gate must never shorten a concurrently reported quota delay.
var extend = redis.NewScript(`
local previous = tonumber(redis.call('GET', KEYS[1])) or 0
if previous > 253402300799000 then previous = 0 end
local requested = tonumber(ARGV[1])
if requested > previous then
 redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[2])
 return requested
end
return previous
`)

// Extend records the limit locally before attempting Redis. A Redis failure is
// nonfatal, matching the TypeScript quota gate. Only valid future instants are
// retained; timestamps are bounded to avoid overflow in Redis TTL arithmetic.
func (g *Gate) Extend(ctx context.Context, provider, scope string, reset time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	millis := reset.UnixMilli()
	if millis <= now || millis > 253402300799000 {
		return nil
	}
	k := key(provider, scope)
	millis = g.remember(k, millis, now)
	if g.client != nil {
		shared, err := extend.Run(ctx, g.client, []string{k}, millis, millis+10000).Int64()
		if err == nil {
			g.remember(k, shared, time.Now().UnixMilli())
		}
	}
	return ctx.Err()
}
