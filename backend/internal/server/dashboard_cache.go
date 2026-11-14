package server

import (
	"context"
	"errors"
	"sync"
	"time"
)

type dashboardCacheEntry struct {
	done    chan struct{}
	err     error
	expires time.Time
	order   uint64
}

type dashboardCache struct {
	mu       sync.Mutex
	entries  map[string]*dashboardCacheEntry
	sequence uint64
	now      func() time.Time
}

func (c *dashboardCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}
func (c *dashboardCache) clear() { c.mu.Lock(); c.entries = nil; c.mu.Unlock() }

// Match AsyncCache's 64-entry FIFO bound and five-minute TTL after success.
// In-flight entries do not expire, failed work is retried, and clearing cannot
// let an older completion replace or remove a newer entry for the same user.
func (c *dashboardCache) run(ctx context.Context, key string, calculate func() error) (err error) {
	c.mu.Lock()
	now := c.clock()
	for key, entry := range c.entries {
		if !entry.expires.IsZero() && !entry.expires.After(now) {
			delete(c.entries, key)
		}
	}
	if cached := c.entries[key]; cached != nil {
		c.mu.Unlock()
		select {
		case <-cached.done:
			return cached.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if len(c.entries) >= 64 {
		var oldest string
		var first *dashboardCacheEntry
		for key, entry := range c.entries {
			if first == nil || entry.order < first.order {
				oldest, first = key, entry
			}
		}
		delete(c.entries, oldest)
	}
	if c.entries == nil {
		c.entries = map[string]*dashboardCacheEntry{}
	}
	c.sequence++
	entry := &dashboardCacheEntry{done: make(chan struct{}), order: c.sequence}
	c.entries[key] = entry
	c.mu.Unlock()
	err = errors.New("dashboard_reconciliation_interrupted")
	defer func() {
		c.mu.Lock()
		entry.err = err
		if err == nil {
			entry.expires = c.clock().Add(5 * time.Minute)
		} else if c.entries[key] == entry {
			delete(c.entries, key)
		}
		close(entry.done)
		c.mu.Unlock()
	}()
	err = calculate()
	return err
}
