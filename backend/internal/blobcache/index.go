// Package blobcache implements the shared filesystem cache index used by the
// TypeScript backend. The schema includes content and lease metadata; the
// methods expose accounting, transformation decisions, leased readers, bounded
// fills and recovery. Callers must authorize access before using cached content.
package blobcache

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

type Options struct {
	Root              string
	Budget, MaxObject int64
	Gzip              bool
	Saving, LowWater  *float64
	FreeBytes         int64
	Name              string
	Observe           func(Event)
	Stage             func(context.Context, string, time.Duration, error)
}

type Cache struct {
	db              *sql.DB
	options         Options
	now             func() time.Time
	root            *os.Root
	lifecycle       sync.RWMutex
	closed          bool
	readersMu       sync.Mutex
	readers         map[*Reader]struct{}
	closeOnce       sync.Once
	closeErr        error
	readerHeartbeat time.Duration
	fillHeartbeat   time.Duration
	fillTimeout     time.Duration
	fillWait        time.Duration
	fillsMu         sync.Mutex
	fills           map[*fillOperation]struct{}
}

func New(ctx context.Context, options Options) (*Cache, error) {
	if options.Budget <= 0 || options.MaxObject <= 0 || options.MaxObject > (math.MaxInt64-1024)/3 || options.FreeBytes < 0 {
		return nil, errors.New("invalid_cache_budget")
	}
	for _, value := range []*float64{options.Saving, options.LowWater} {
		if value != nil && (math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0 || *value > 1) {
			return nil, errors.New("invalid_cache_options")
		}
	}
	if options.Name == "" {
		options.Name = "source"
	}
	root, err := filepath.Abs(options.Root)
	if err != nil {
		return nil, err
	}
	options.Root = root
	if err := os.MkdirAll(filepath.Join(root, "tmp"), 0700); err != nil {
		return nil, err
	}
	index := filepath.Join(root, "index.sqlite")
	// Never open and close an existing index outside SQLite: POSIX file locks
	// can be released by closing another descriptor for the same inode.
	file, err := os.OpenFile(index, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	if err == nil {
		if err = file.Close(); err != nil {
			return nil, err
		}
	}
	// Apply connection-local settings to every connection, including replacements.
	location := url.URL{Scheme: "file", Path: index}
	params := url.Values{"_txlock": {"immediate"}, "_pragma": {"busy_timeout(50)", "foreign_keys(ON)", "recursive_triggers(ON)", "synchronous(NORMAL)"}}
	location.RawQuery = params.Encode()
	db, err := sql.Open("sqlite", location.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	rootHandle, err := os.OpenRoot(root)
	if err != nil {
		db.Close()
		return nil, err
	}
	cache := &Cache{db: db, options: options, now: time.Now, root: rootHandle, readers: map[*Reader]struct{}{}, readerHeartbeat: 30 * time.Second, fillHeartbeat: 30 * time.Second, fillTimeout: 120 * time.Second, fillWait: 120 * time.Second, fills: map[*fillOperation]struct{}{}}
	if err := cache.initialize(ctx); err != nil {
		rootHandle.Close()
		db.Close()
		return nil, err
	}
	return cache, nil
}

// Connection pragmas and switching a new database to WAL may return BUSY
// before SQLite's busy handler can wait. Initialization only performs
// idempotent SQL and rolls back failed transactions, so retry the whole attempt.
func (c *Cache) initialize(ctx context.Context) error {
	work, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		err := c.initializeAttempt(work)
		if err == nil {
			return nil
		}
		if work.Err() != nil {
			return context.Cause(work)
		}
		var sqliteErr *sqlite.Error
		if !errors.As(err, &sqliteErr) || sqliteErr.Code()&255 != 5 {
			return err
		}
		select {
		case <-work.Done():
			return context.Cause(work)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func (c *Cache) initializeAttempt(ctx context.Context) error {
	conn, err := c.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "PRAGMA busy_timeout=50; PRAGMA journal_mode=WAL;"); err != nil {
		return err
	}
	// Contending processes may hold the writer lock longer than busy_timeout.
	// Retry only BEGIN, never fn: callbacks can rename or remove payload files.
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	var tx *sql.Tx
	for {
		tx, err = conn.BeginTx(ctx, nil)
		if err == nil {
			break
		}
		var sqliteErr *sqlite.Error
		if !errors.As(err, &sqliteErr) || sqliteErr.Code()&255 != 5 {
			return err
		}
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-deadline.C:
			return err
		case <-time.After(10 * time.Millisecond):
		}
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, schema); err != nil {
		return err
	}
	var hasClassification int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM pragma_table_info('decisions') WHERE name='isText'").Scan(&hasClassification); err != nil {
		return err
	}
	if hasClassification == 0 {
		if _, err = tx.ExecContext(ctx, "ALTER TABLE decisions ADD COLUMN isText INTEGER"); err != nil {
			return err
		}
	}

	// Backfill pre-summary TypeScript databases exactly once, under the same
	// write lock as schema creation. Existing counters must not be reset.
	if _, err = tx.ExecContext(ctx, `INSERT INTO totals SELECT 1,COALESCE(SUM(allocated),0) FROM blobs
 HAVING NOT EXISTS(SELECT 1 FROM totals WHERE id=1);
 INSERT INTO summary SELECT 1,COUNT(*),COALESCE(SUM(size),0),COALESCE(SUM(stored),0),COALESCE(SUM(allocated),0),
 (SELECT COUNT(*) FROM readers),(SELECT COUNT(*) FROM decisions),(SELECT COUNT(*) FROM aliases),(SELECT COUNT(*) FROM history),(SELECT COALESCE(SUM(reserved),0) FROM fills)
 FROM blobs HAVING NOT EXISTS(SELECT 1 FROM summary WHERE id=1);`); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "PRAGMA busy_timeout=50;")
	return err
}

// transaction reserves one connection for the entire synchronous-mode change.
// SQLite cannot change synchronous inside a transaction. FULL is required by
// the fill/publication protocol before creating or renaming payload files.
func (c *Cache) transaction(ctx context.Context, durable bool, fn func(*sql.Tx) error) (err error) {
	conn, err := c.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if durable {
		if _, err = conn.ExecContext(ctx, "PRAGMA synchronous=FULL"); err != nil {
			return err
		}
		defer func() {
			cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, resetErr := conn.ExecContext(cleanup, "PRAGMA synchronous=NORMAL")
			if err == nil {
				err = resetErr
			}
		}()
	}
	// Contending processes may hold the writer lock longer than busy_timeout.
	// Retry only BEGIN, never fn: callbacks can rename or remove payload files.
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	var tx *sql.Tx
	for {
		tx, err = conn.BeginTx(ctx, nil)
		if err == nil {
			break
		}
		var sqliteErr *sqlite.Error
		if !errors.As(err, &sqliteErr) || sqliteErr.Code()&255 != 5 {
			return err
		}
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-deadline.C:
			return err
		case <-time.After(10 * time.Millisecond):
		}
	}
	defer tx.Rollback()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *Cache) Close() error {
	c.closeOnce.Do(func() {
		c.lifecycle.Lock()
		c.closed = true
		c.fillsMu.Lock()
		fills := make([]*fillOperation, 0, len(c.fills))
		for fill := range c.fills {
			fills = append(fills, fill)
		}
		c.fillsMu.Unlock()
		c.readersMu.Lock()
		readers := make([]*Reader, 0, len(c.readers))
		for reader := range c.readers {
			readers = append(readers, reader)
		}
		c.readersMu.Unlock()
		c.lifecycle.Unlock()
		for _, fill := range fills {
			fill.cancel(os.ErrClosed)
		}
		for _, reader := range readers {
			reader.Close()
		}
		for _, fill := range fills {
			<-fill.done
		}
		c.closeErr = errors.Join(c.db.Close(), c.root.Close())
	})
	return c.closeErr
}

type Stats struct {
	Blobs          int64  `json:"blobs"`
	OriginalBytes  int64  `json:"originalBytes"`
	StoredBytes    int64  `json:"storedBytes"`
	AllocatedBytes int64  `json:"allocatedBytes"`
	ActiveReaders  int64  `json:"activeReaders"`
	Decisions      int64  `json:"decisions"`
	ReservedBytes  int64  `json:"reservedBytes"`
	BudgetBytes    int64  `json:"budgetBytes"`
	MaxObjectBytes int64  `json:"maxObjectBytes"`
	OldestAccess   *int64 `json:"oldestAccess"`
}

func (c *Cache) Stats(ctx context.Context) (Stats, error) {
	result := Stats{BudgetBytes: c.options.Budget, MaxObjectBytes: c.options.MaxObject}
	err := c.db.QueryRowContext(ctx, `SELECT blobs,originalBytes,storedBytes,allocatedBytes,activeReaders,decisions,reservedBytes,
 (SELECT accessed FROM blobs ORDER BY accessed LIMIT 1) FROM summary WHERE id=1`).Scan(&result.Blobs, &result.OriginalBytes, &result.StoredBytes, &result.AllocatedBytes, &result.ActiveReaders, &result.Decisions, &result.ReservedBytes, &result.OldestAccess)
	return result, err
}

type Decision struct {
	Digest  string `json:"digest"`
	Changed bool   `json:"changed"`
}

func (c *Cache) Decision(ctx context.Context, key string) (*Decision, error) {
	now := c.now().UnixMilli()
	var result Decision
	var changed int64
	err := c.db.QueryRowContext(ctx, "SELECT digest,changed FROM decisions WHERE key=? AND expires>?", key, now).Scan(&result.Digest, &changed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	result.Changed = changed != 0
	_, err = c.db.ExecContext(ctx, "UPDATE decisions SET accessed=? WHERE key=? AND accessed<?", now, key, now-30000)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Cache) SaveDecision(ctx context.Context, key, digest string, changed bool) error {
	now := c.now().UnixMilli()
	return c.transaction(ctx, false, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO decisions(key,digest,changed,accessed,expires,isText) VALUES(?,?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest,changed=excluded.changed,accessed=excluded.accessed,expires=excluded.expires,isText=NULL`, key, digest, changed, now, now+7*86400000)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM decisions WHERE rowid IN (SELECT rowid FROM decisions ORDER BY accessed LIMIT MAX(0,(SELECT decisions FROM summary WHERE id=1)-100000))`)
		return err
	})
}
