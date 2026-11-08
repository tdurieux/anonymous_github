package blobcache

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"os"
	"path"
	"regexp"
	"time"
)

var validFillToken = regexp.MustCompile(`^[a-zA-Z0-9-]{1,128}$`)
var errCachePayloadNotFile = errors.New("cache_payload_not_file")

func (c *Cache) removePayload(name string) error {
	info, err := c.root.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errCachePayloadNotFile
	}
	err = c.root.Remove(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// expire runs under the caller's write transaction. Unlinking files precedes
// releasing their reservation; a failed transaction can overcount disk usage,
// but it cannot forget a producer's remaining files.
func (c *Cache) expire(ctx context.Context, tx *sql.Tx) error {
	now := c.now().UnixMilli()
	for {
		rows, err := tx.QueryContext(ctx, "SELECT key,token FROM fills WHERE expires<? ORDER BY key LIMIT 256", now)
		if err != nil {
			return err
		}
		var dead []struct{ key, token string }
		for rows.Next() {
			var fill struct{ key, token string }
			if err = rows.Scan(&fill.key, &fill.token); err != nil {
				break
			}
			dead = append(dead, fill)
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return err
		}
		if len(dead) == 0 {
			break
		}
		for _, fill := range dead {
			if err := ctx.Err(); err != nil {
				return err
			}
			if !validFillToken.MatchString(fill.token) {
				return ErrInvalidRecord
			}
			var digest, file string
			err := tx.QueryRowContext(ctx, "SELECT digest,file FROM publications WHERE token=?", fill.token).Scan(&digest, &file)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if err == nil {
				var indexed bool
				if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM blobs WHERE file=?)", file).Scan(&indexed); err != nil {
					return err
				}
				if !indexed {
					name, err := blobLocation(digest, file)
					if err != nil {
						return err
					}
					if err = c.removePayload(name); err != nil {
						return err
					}
				}
			}
			for _, suffix := range []string{"raw", "gz"} {
				if err := c.removePayload(path.Join("tmp", fill.token+"."+suffix)); err != nil {
					return err
				}
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM publications WHERE token=?", fill.token); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM fills WHERE key=? AND token=?", fill.key, fill.token); err != nil {
				return err
			}
		}
	}
	for _, query := range []struct {
		sql    string
		before int64
	}{
		{"DELETE FROM readers WHERE expires<?", now},
		{"DELETE FROM decisions WHERE rowid IN (SELECT rowid FROM decisions WHERE expires<? ORDER BY expires LIMIT 256)", now},
		{"DELETE FROM history WHERE rowid IN (SELECT rowid FROM history WHERE seen<? ORDER BY seen LIMIT 256)", now - 7*86400000},
	} {
		if _, err := tx.ExecContext(ctx, query.sql, query.before); err != nil {
			return err
		}
	}
	return nil
}

func (c *Cache) evictTo(ctx context.Context, tx *sql.Tx, target int64) error {
	var used int64
	if err := tx.QueryRowContext(ctx, "SELECT allocatedBytes FROM summary WHERE id=1").Scan(&used); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT digest,file,size,stored,allocated,encoding,accessed FROM blobs
 WHERE digest NOT IN(SELECT digest FROM readers) ORDER BY accessed LIMIT 512`)
	if err != nil {
		return err
	}
	var candidates []Record
	for rows.Next() {
		var record Record
		if err = rows.Scan(&record.Digest, &record.File, &record.Size, &record.Stored, &record.Allocated, &record.Encoding, &record.Accessed); err != nil {
			break
		}
		candidates = append(candidates, record)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	for _, record := range candidates {
		if used <= target {
			break
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		name, err := blobPath(record)
		if err != nil {
			return err
		}
		if err = c.removePayload(name); err != nil {
			continue
		}
		if _, err = tx.ExecContext(ctx, "UPDATE history SET evicted=1 WHERE key IN(SELECT key FROM aliases WHERE digest=?)", record.Digest); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM blobs WHERE digest=? AND file=?", record.Digest, record.File); err != nil {
			return err
		}
		// Remove only an empty publication directory, never another representation.
		c.root.Remove(path.Dir(name))
		used -= record.Allocated
		c.emit(ctx, "eviction", record.Stored, c.now().Sub(time.UnixMilli(record.Accessed)))
	}
	return nil
}

func (c *Cache) Maintain(ctx context.Context) error {
	c.lifecycle.RLock()
	defer c.lifecycle.RUnlock()
	if c.closed {
		return os.ErrClosed
	}
	if err := c.transaction(ctx, false, func(tx *sql.Tx) error {
		if err := c.expire(ctx, tx); err != nil {
			return err
		}
		var reserved int64
		if err := tx.QueryRowContext(ctx, "SELECT reservedBytes FROM summary WHERE id=1").Scan(&reserved); err != nil {
			return err
		}
		target := int64(0)
		if reserved < c.options.Budget {
			target = c.options.Budget - reserved
		}
		return c.evictTo(ctx, tx, target)
	}); err != nil {
		return err
	}
	now := c.now().UnixMilli()
	claim := now + time.Hour.Milliseconds()
	scan := false
	if err := c.transaction(ctx, false, func(tx *sql.Tx) error {
		var next int64
		err := tx.QueryRowContext(ctx, "SELECT nextScan FROM maintenance WHERE id=1").Scan(&next)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil && next > now {
			return nil
		}
		if _, err = tx.ExecContext(ctx, "INSERT OR REPLACE INTO maintenance VALUES(1,?)", claim); err != nil {
			return err
		}
		scan = true
		return nil
	}); err != nil {
		return err
	}
	if !scan {
		return nil
	}
	if err := c.scanOrphans(ctx, "blobs", 0); err != nil {
		// A partial scan must be retryable. A stale scanner cannot clear a newer
		// process's claim after its own one-hour interval has elapsed.
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		c.db.ExecContext(cleanup, "UPDATE maintenance SET nextScan=? WHERE id=1 AND nextScan=?", now, claim)
		return err
	}
	return nil
}

func (c *Cache) scanOrphans(ctx context.Context, directory string, depth int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if depth > 64 {
		return errors.New("cache_directory_depth_exceeded")
	}
	info, err := c.root.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return ErrInvalidRecord
	}
	dir, err := c.root.Open(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer dir.Close()
	for {
		entries, readErr := dir.ReadDir(128)
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			name := path.Join(directory, entry.Name())
			if entry.IsDir() {
				if err := c.scanOrphans(ctx, name, depth+1); err != nil {
					return err
				}
				continue
			}
			// Lstat inspects links themselves. Orphan cleanup never follows them.
			info, err := c.root.Lstat(name)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			now := c.now()
			if now.Sub(info.ModTime()) < time.Hour {
				continue
			}
			if err := c.transaction(ctx, false, func(tx *sql.Tx) error {
				var protected bool
				if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM blobs WHERE file=?) OR EXISTS(
     SELECT 1 FROM publications p JOIN fills f ON p.token=f.token WHERE p.file=? AND f.expires>=?)`, entry.Name(), entry.Name(), now.UnixMilli()).Scan(&protected); err != nil {
					return err
				}
				if protected {
					return nil
				}
				return c.removePayload(name)
			}); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}
