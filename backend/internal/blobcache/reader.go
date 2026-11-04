package blobcache

import (
	"compress/flate"
	"compress/gzip"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"os"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
)

var validDigest = regexp.MustCompile(`^(git-[a-f0-9]{40}|sha256-[a-f0-9]{64})$`)
var validBlobFile = regexp.MustCompile(`^[a-f0-9-]+\.(gz|raw)$`)
var ErrInvalidRecord = errors.New("invalid_blob_record")
var ErrReaderLeaseLost = errors.New("cache_reader_lease_lost")
var errBlobSize = errors.New("corrupt_blob_size")

const readerLease = 120 * time.Second

type Record struct {
	Digest    string `json:"digest"`
	File      string `json:"file"`
	Size      int64  `json:"size"`
	Stored    int64  `json:"stored"`
	Allocated int64  `json:"allocated"`
	Encoding  string `json:"encoding"`
	Accessed  int64  `json:"accessed"`
}

func blobLocation(digest, file string) (string, error) {
	if !validDigest.MatchString(digest) || len(file) > 128 || !validBlobFile.MatchString(file) {
		return "", ErrInvalidRecord
	}
	hex := strings.SplitN(digest, "-", 2)[1]
	return path.Join("blobs", hex[:2], digest, file), nil
}

func blobPath(record Record) (string, error) {
	if record.Size < 0 || record.Size == math.MaxInt64 || record.Stored < 0 || record.Stored == math.MaxInt64 || record.Allocated < 0 ||
		(record.Encoding != "identity" && record.Encoding != "gzip") {
		return "", ErrInvalidRecord
	}
	return blobLocation(record.Digest, record.File)
}

func newToken() (string, error) {
	var token [32]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(token[:]), nil
}

// Open pins the exact published record before opening its file. A nil reader
// means a miss. encoded returns stored gzip bytes without decompressing them.
// Authorization belongs to the caller and must precede even a cache hit.
func (c *Cache) Open(ctx context.Context, digest string, encoded bool) (*Reader, error) {
	return c.open(ctx, ctx, digest, encoded)
}
func (c *Cache) open(ctx, readerContext context.Context, digest string, encoded bool) (*Reader, error) {
	c.lifecycle.RLock()
	defer c.lifecycle.RUnlock()
	if c.closed {
		return nil, os.ErrClosed
	}
	if !validDigest.MatchString(digest) {
		return nil, nil
	}
	token, err := newToken()
	if err != nil {
		return nil, err
	}
	var record Record
	var name string
	now := c.now().UnixMilli()
	err = c.transaction(ctx, false, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, "SELECT digest,file,size,stored,allocated,encoding,accessed FROM blobs WHERE digest=?", digest).Scan(&record.Digest, &record.File, &record.Size, &record.Stored, &record.Allocated, &record.Encoding, &record.Accessed)
		if err != nil {
			return err
		}
		name, err = blobPath(record)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO readers VALUES(?,?,?)", token, digest, now+readerLease.Milliseconds()); err != nil {
			return err
		}
		if now-record.Accessed > 30000 {
			_, err = tx.ExecContext(ctx, "UPDATE blobs SET accessed=? WHERE digest=?", now, digest)
		}
		return err
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// Check the type before opening to avoid blocking on a corrupt FIFO entry.
	info, err := c.root.Lstat(name)
	var file *os.File
	if err == nil && !info.Mode().IsRegular() {
		err = ErrInvalidRecord
	}
	if err == nil {
		file, err = c.root.Open(name)
	}
	if err == nil {
		info, err = file.Stat()
	}
	if err == nil && (!info.Mode().IsRegular() || info.Size() != record.Stored) {
		err = errBlobSize
	}
	if err != nil || ctx.Err() != nil {
		if file != nil {
			file.Close()
		}
		c.releaseReader(token)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err = c.discardRecord(ctx, record); err != nil {
			return nil, err
		}
		c.emit(ctx, "corrupt", 0, 0)
		return nil, nil
	}
	life, cancel := context.WithCancelCause(readerContext)
	remaining := record.Stored
	if record.Encoding == "gzip" && !encoded {
		remaining = record.Size
	}
	reader := &Reader{cache: c, record: record, token: token, file: file, ctx: life, cancel: cancel, done: make(chan struct{}), decode: record.Encoding == "gzip" && !encoded, remaining: remaining}
	c.readersMu.Lock()
	c.readers[reader] = struct{}{}
	c.readersMu.Unlock()
	go reader.heartbeat()
	return reader, nil
}

func (c *Cache) Lookup(ctx context.Context, key string) (*Reader, error) {
	return c.lookup(ctx, ctx, key)
}
func (c *Cache) lookup(ctx, readerContext context.Context, key string) (result *Reader, resultErr error) {
	started := time.Now()
	defer func() {
		if c.options.Stage != nil {
			c.options.Stage(readerContext, "cache_lookup", time.Since(started), resultErr)
		}
	}()
	c.lifecycle.RLock()
	if c.closed {
		c.lifecycle.RUnlock()
		return nil, os.ErrClosed
	}
	var digest string
	err := c.db.QueryRowContext(ctx, "SELECT digest FROM aliases WHERE key=?", key).Scan(&digest)
	c.lifecycle.RUnlock()
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if digest == "" {
		digest = key
	}
	return c.open(ctx, readerContext, digest, false)
}

func (c *Cache) releaseReader(token string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	// Failed release is recoverable through the two-minute lease expiry.
	_ = c.transaction(ctx, false, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "DELETE FROM readers WHERE token=?", token)
		return err
	})
}

func (c *Cache) discardRecord(ctx context.Context, record Record) error {
	name, err := blobPath(record)
	if err != nil {
		return err
	}
	// Publication names are unique. Never delete a newer record for this digest.
	c.root.Remove(name)
	return c.transaction(ctx, false, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "DELETE FROM blobs WHERE digest=? AND file=?", record.Digest, record.File)
		return err
	})
}

// Reader releases its lease on EOF, read failure, context cancellation or Close.
// Gzip decoding starts on the first Read, allowing unused streams to be closed.
type Reader struct {
	cache     *Cache
	record    Record
	token     string
	file      *os.File
	ctx       context.Context
	cancel    context.CancelCauseFunc
	done      chan struct{}
	once      sync.Once
	readMu    sync.Mutex
	gzip      *gzip.Reader
	decode    bool
	remaining int64
	started   time.Time
}

func (r *Reader) Record() Record { return r.record }

func (r *Reader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	r.readMu.Lock()
	n, err := r.read(p)
	r.readMu.Unlock()
	if r.ctx.Err() != nil {
		err = context.Cause(r.ctx)
	}
	if err != nil {
		r.finish(err)
		<-r.done
	}
	return n, err
}

func (r *Reader) read(p []byte) (int, error) {
	if r.ctx.Err() != nil {
		return 0, context.Cause(r.ctx)
	}
	var input io.Reader = r.file
	if r.decode {
		if r.gzip == nil {
			r.started = time.Now()
			decoder, err := gzip.NewReader(r.file)
			if err != nil {
				return 0, err
			}
			r.gzip = decoder
		}
		input = r.gzip
	}
	if int64(len(p)) > r.remaining+1 {
		p = p[:r.remaining+1]
	}
	n, err := input.Read(p)
	if int64(n) > r.remaining {
		n = int(r.remaining)
		r.remaining = 0
		return n, errBlobSize
	}
	r.remaining -= int64(n)
	if errors.Is(err, io.EOF) && r.remaining != 0 {
		err = io.ErrUnexpectedEOF
	}
	return n, err
}

func (r *Reader) renew() error {
	now := r.cache.now().UnixMilli()
	result, err := r.cache.db.ExecContext(r.ctx, "UPDATE readers SET expires=? WHERE token=? AND expires>=?", now+readerLease.Milliseconds(), r.token, now)
	if err != nil {
		return ErrReaderLeaseLost
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		return ErrReaderLeaseLost
	}
	return nil
}

func (r *Reader) heartbeat() {
	defer close(r.done)
	ticker := time.NewTicker(r.cache.readerHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-r.ctx.Done():
			r.finish(context.Cause(r.ctx))
			return
		case <-ticker.C:
			if err := r.renew(); err != nil {
				if r.ctx.Err() != nil {
					err = context.Cause(r.ctx)
				}
				r.finish(err)
				return
			}
		}
	}
}

func (r *Reader) finish(cause error) {
	r.once.Do(func() {
		r.cancel(cause)
		r.file.Close()
		r.readMu.Lock()
		if r.gzip != nil {
			r.gzip.Close()
		}
		if cause == io.EOF && r.decode && !r.started.IsZero() {
			r.cache.transformEvent(r.ctx, "decompress", r.record.Size, time.Since(r.started))
		}
		r.readMu.Unlock()
		r.cache.releaseReader(r.token)
		var corrupt flate.CorruptInputError
		if errors.Is(cause, errBlobSize) || errors.Is(cause, io.ErrUnexpectedEOF) || errors.Is(cause, gzip.ErrHeader) || errors.Is(cause, gzip.ErrChecksum) || errors.As(cause, &corrupt) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			r.cache.discardRecord(ctx, r.record)
			cancel()
		}
		r.cache.readersMu.Lock()
		delete(r.cache.readers, r)
		r.cache.readersMu.Unlock()
	})
}

func (r *Reader) Close() error { r.finish(os.ErrClosed); <-r.done; return nil }

// Reopen acquires another reader lease for this content. Keeping the current
// reader pinned prevents eviction while HTTP selects the stored representation.
func (r *Reader) Reopen(ctx context.Context, encoded bool) (*Reader, error) {
	return r.cache.Open(ctx, r.record.Digest, encoded)
}
