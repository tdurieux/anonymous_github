package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type statsCacheEntry struct {
	done    chan struct{}
	value   any
	err     error
	expires time.Time
	order   uint64
}
type statsCache struct {
	mu       sync.Mutex
	entries  map[string]*statsCacheEntry
	sequence uint64
	now      func() time.Time
}

func (c *statsCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// Match AsyncCache's FIFO capacity, in-flight coalescing, one-hour TTL after
// success and immediate retry after failure. Waiters can cancel independently.
func (c *statsCache) get(ctx context.Context, key string, capacity int, calculate func() (any, error)) (value any, err error) {
	c.mu.Lock()
	now := c.clock()
	for key, entry := range c.entries {
		if !entry.expires.IsZero() && !entry.expires.After(now) {
			delete(c.entries, key)
		}
	}
	if entry := c.entries[key]; entry != nil {
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-entry.done:
			return entry.value, entry.err
		}
	}
	if len(c.entries) >= capacity {
		var first string
		var oldest *statsCacheEntry
		for k, e := range c.entries {
			if oldest == nil || e.order < oldest.order {
				first, oldest = k, e
			}
		}
		delete(c.entries, first)
	}
	if c.entries == nil {
		c.entries = map[string]*statsCacheEntry{}
	}
	c.sequence++
	entry := &statsCacheEntry{done: make(chan struct{}), order: c.sequence}
	c.entries[key] = entry
	c.mu.Unlock()
	err = errors.New("statistics_calculation_interrupted")
	defer func() {
		c.mu.Lock()
		entry.value, entry.err = value, err
		if err == nil {
			entry.expires = c.clock().Add(time.Hour)
		} else if c.entries[key] == entry {
			delete(c.entries, key)
		}
		close(entry.done)
		c.mu.Unlock()
	}()
	return calculate()
}

type publicStatsState struct {
	current, history statsCache
	mu               sync.Mutex
	client           *redis.Client
	closed           bool
}

func (s *Server) statsRedis() *redis.Client {
	state := &s.publicStats
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closed || s.Store == nil || s.Store.Redis == nil {
		return nil
	}
	if state.client == nil {
		options := *s.Store.Redis.Options()
		options.Dialer = nil // Rebuild the default dialer with the bounded cache timeout.
		options.DialTimeout = 500 * time.Millisecond
		options.ReadTimeout = time.Second
		options.WriteTimeout = time.Second
		options.PoolTimeout = time.Second
		options.ContextTimeoutEnabled = true
		options.MaxRetries = -1
		options.PoolSize = 2
		state.client = redis.NewClient(&options)
	}
	return state.client
}
func (s *Server) closeStatsCache() {
	state := &s.publicStats
	state.mu.Lock()
	defer state.mu.Unlock()
	state.closed = true
	if state.client != nil {
		state.client.Close()
	}
}

const publicStatsKey = "perf:home-stats:v1"
const publicStatsLease = "perf:lease:perf:home-stats:v1"
const statsLeaseRelease = `if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`
const statsLeaseRenew = `if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end`

func statsFields(value M) M {
	return selectFields(value, "nbRepositories", "nbUsers", "nbPageViews", "nbPullRequests")
}
func validCachedStats(raw []byte) (M, bool) {
	var value M
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, false
	}
	for _, key := range []string{"nbRepositories", "nbUsers", "nbPageViews", "nbPullRequests"} {
		if n, ok := value[key].(float64); !ok || n < 0 {
			return nil, false
		}
	}
	return statsFields(value), true
}
func (s *Server) getCurrentStats(ctx context.Context) (M, error) {
	value, err := s.publicStats.current.get(ctx, "current", 1, func() (any, error) { return s.fillCurrentStats(ctx) })
	if err != nil {
		return nil, err
	}
	return statsFields(value.(M)), nil
}
func (s *Server) fillCurrentStats(ctx context.Context) (M, error) {
	client := s.statsRedis()
	produce := func() (M, error) {
		value, err := s.computeStats(ctx)
		if err != nil {
			return nil, err
		}
		if client != nil {
			raw, _ := json.Marshal(value)
			write, cancel := context.WithTimeout(ctx, time.Second)
			client.Set(write, publicStatsKey, raw, time.Hour)
			cancel()
		}
		return value, nil
	}
	if client == nil {
		return produce()
	}
	token := uuid.NewString()
	deadline := time.Now().Add(120 * time.Second)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		read, cancel := context.WithTimeout(ctx, time.Second)
		raw, err := client.Get(read, publicStatsKey).Bytes()
		cancel()
		if err == nil {
			if value, ok := validCachedStats(raw); ok {
				return value, nil
			}
		} else if !errors.Is(err, redis.Nil) {
			client = nil
			return produce()
		}
		acquire, cancel := context.WithTimeout(ctx, time.Second)
		owned, err := client.SetNX(acquire, publicStatsLease, token, 30*time.Second).Result()
		cancel()
		if err != nil {
			client = nil
			return produce()
		}
		if owned {
			heartbeat, stop := context.WithCancel(ctx)
			done := make(chan struct{})
			go func() {
				defer close(done)
				ticker := time.NewTicker(10 * time.Second)
				defer ticker.Stop()
				for {
					select {
					case <-heartbeat.Done():
						return
					case <-ticker.C:
						renew, cancel := context.WithTimeout(heartbeat, time.Second)
						client.Eval(renew, statsLeaseRenew, []string{publicStatsLease}, token, 30000)
						cancel()
					}
				}
			}()
			defer func() {
				stop()
				<-done
				release, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
				defer cancel()
				client.Eval(release, statsLeaseRelease, []string{publicStatsLease}, token)
			}()
			return produce()
		}
		if !time.Now().Before(deadline) {
			return nil, errors.New("cache_fill_timeout")
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
func publicStatsDays(raw string) int64 {
	raw = strings.TrimLeftFunc(raw, func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' })
	if strings.HasPrefix(raw, "-") {
		if len(raw) < 2 || raw[1] < '0' || raw[1] > '9' {
			return 30
		}
		n := adminPageInt(raw[1:], 0, 365)
		if n > 0 {
			return 1
		}
		return 30
	}
	return adminPageInt(raw, 30, 365)
}
func (s *Server) getStatsHistory(ctx context.Context, days int64, now time.Time) ([]M, error) {
	if days == 0 {
		days = 30
	}
	days = min(int64(365), max(int64(1), days))
	key := fmt.Sprintf("%s:%d", now.UTC().Format("2006-01-02"), days)
	value, err := s.publicStats.history.get(ctx, key, 16, func() (any, error) {
		current, err := s.getCurrentStats(ctx)
		if err != nil {
			return nil, err
		}
		return s.statsHistory(ctx, days, current, now)
	})
	if err != nil {
		return nil, err
	}
	rows := value.([]M)
	out := make([]M, len(rows))
	for i, row := range rows {
		out[i] = statsFields(row)
		out[i]["date"] = row["date"]
	}
	return out, nil
}
