package blobcache

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Observe callbacks must be fast and must not call back into Cache. The server
// can buffer these events without making database writes in the callback.
type Event struct {
	Context  context.Context
	Name     string
	Bytes    int64
	Duration time.Duration
}

func (c *Cache) emit(ctx context.Context, event string, bytes int64, duration time.Duration) {
	if c.options.Observe != nil {
		c.options.Observe(Event{Context: ctx, Name: c.options.Name + "_" + event, Bytes: bytes, Duration: duration})
	}
}
func (c *Cache) transformEvent(ctx context.Context, event string, bytes int64, duration time.Duration) {
	if c.options.Observe != nil {
		c.options.Observe(Event{Context: ctx, Name: event, Bytes: bytes, Duration: duration})
	}
}
func (c *Cache) accessed(ctx context.Context, key string, hit bool, bytes int64) error {
	now := c.now().UnixMilli()
	var seen int64
	var evicted bool
	err := c.db.QueryRowContext(ctx, "SELECT seen,evicted FROM history WHERE key=? AND seen>=?", key, now-7*86400000).Scan(&seen, &evicted)
	previous := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if hit {
		c.emit(ctx, "hit", bytes, 0)
	} else {
		c.emit(ctx, "miss", bytes, 0)
		switch {
		case previous && evicted:
			c.emit(ctx, "refetch", 0, 0)
		case previous:
			c.emit(ctx, "known_miss", 0, 0)
		default:
			c.emit(ctx, "first_seen_miss", 0, 0)
		}
	}
	if previous {
		age := now - seen
		for _, window := range []struct {
			name  string
			limit int64
		}{{"1h", 3600000}, {"1d", 86400000}, {"7d", 604800000}} {
			if age <= window.limit {
				c.emit(ctx, "reuse_"+window.name, bytes, 0)
			}
		}
	}
	if previous && !evicted && now-seen < 30000 {
		return nil
	}
	return c.transaction(ctx, false, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "INSERT INTO history VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET seen=excluded.seen,evicted=0", key, now); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM history WHERE rowid IN(SELECT rowid FROM history ORDER BY seen LIMIT MAX(0,(SELECT history FROM summary WHERE id=1)-100000))`)
		return err
	})
}
