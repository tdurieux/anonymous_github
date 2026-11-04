package blobcache

import (
	"compress/gzip"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"regexp"
	"sync"
	"time"
)

var validKey = regexp.MustCompile(`^[a-z0-9-]{1,100}$`)
var ErrFillLeaseLost = errors.New("cache_fill_lease_lost")
var errFillTimeout = errors.New("cache_fill_timeout")

type AdmissionError struct{ Code string }

func (e *AdmissionError) Error() string { return e.Code }

type Proof struct {
	GitSHA, SHA256 string
	Size           int64
}

// Producers and verifiers must honor their context. Cancellation also closes
// a returned input stream to interrupt reads blocked on upstream I/O.
type Producer func(context.Context) (io.ReadCloser, error)
type Verifier func(context.Context, Proof) (string, error)
type fillOperation struct {
	ctx    context.Context
	cancel context.CancelCauseFunc
	done   chan struct{}
}

func (c *Cache) startFill(ctx context.Context) (*fillOperation, error) {
	c.lifecycle.RLock()
	defer c.lifecycle.RUnlock()
	if c.closed {
		return nil, os.ErrClosed
	}
	life, cancel := context.WithCancelCause(ctx)
	op := &fillOperation{ctx: life, cancel: cancel, done: make(chan struct{})}
	c.fillsMu.Lock()
	c.fills[op] = struct{}{}
	c.fillsMu.Unlock()
	return op, nil
}
func (c *Cache) endFill(op *fillOperation) {
	op.cancel(context.Canceled)
	c.fillsMu.Lock()
	delete(c.fills, op)
	c.fillsMu.Unlock()
	close(op.done)
}

func (c *Cache) reservation(unit int64) (int64, error) {
	unit = max(unit, 4096)
	if unit > math.MaxInt64/3 {
		return 0, errors.New("invalid_cache_filesystem")
	}
	blocks := c.options.MaxObject / unit
	if c.options.MaxObject%unit != 0 {
		blocks++
	}
	if blocks > math.MaxInt64/(3*unit) {
		return 0, &AdmissionError{Code: "cache_budget_busy"}
	}
	// Preserve the TS reservation, but cover allocation rounding for small files.
	return max(c.options.MaxObject*3+1024, blocks*unit*3), nil
}

func (c *Cache) claimFill(ctx context.Context, key, token string) (bool, error) {
	available, unit, err := c.diskSpace()
	if err != nil {
		return false, err
	}
	reservation, err := c.reservation(unit)
	if err != nil {
		return false, err
	}
	if available < uint64(reservation)+uint64(c.options.FreeBytes) {
		return false, &AdmissionError{Code: "disk_headroom"}
	}
	owned := false
	err = c.transaction(ctx, true, func(tx *sql.Tx) error {
		if err := c.expire(ctx, tx); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM fills WHERE key=?)", key).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return nil
		}
		var used, reserved int64
		usage := func() error {
			return tx.QueryRowContext(ctx, "SELECT allocatedBytes,reservedBytes FROM summary WHERE id=1").Scan(&used, &reserved)
		}
		if err := usage(); err != nil {
			return err
		}
		fits := func() bool {
			return used >= 0 && reserved >= 0 && reservation <= c.options.Budget && reserved <= c.options.Budget-reservation && used <= c.options.Budget-reservation-reserved
		}
		if !fits() {
			low := 0.9
			if c.options.LowWater != nil {
				low = *c.options.LowWater
			}
			target := int64(0)
			if reservation <= c.options.Budget && reserved >= 0 && reserved <= c.options.Budget-reservation {
				target = min(int64(float64(c.options.Budget)*low), c.options.Budget-reserved-reservation)
			}
			if err := c.evictTo(ctx, tx, max(0, target)); err != nil {
				return err
			}
			if err := usage(); err != nil {
				return err
			}
		}
		if !fits() {
			return &AdmissionError{Code: "cache_budget_busy"}
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO fills VALUES(?,?,?,?)", key, token, c.now().Add(readerLease).UnixMilli(), reservation); err != nil {
			return err
		}
		owned = true
		return nil
	})
	return owned, err
}

// GetOrFill returns a leased decoded reader for an alias or content digest.
// The caller must authorize access even on a hit and close the returned reader.
// A nil verifier uses the computed SHA-256 digest. A verifier may select the
// computed Git or SHA-256 digest after checking provider-owned metadata.
// AdmissionError allows callers to choose an independently bounded fallback.
func (c *Cache) GetOrFill(ctx context.Context, key string, produce Producer, verify Verifier, sizeHint *int64) (reader *Reader, err error) {
	if !validKey.MatchString(key) {
		return nil, errors.New("invalid_cache_key")
	}
	op, err := c.startFill(ctx)
	if err != nil {
		return nil, err
	}
	defer c.endFill(op)
	hit, err := c.lookup(op.ctx, ctx, key)
	if err != nil {
		return nil, err
	}
	bytes := int64(0)
	if sizeHint != nil {
		bytes = *sizeHint
	}
	if hit != nil {
		bytes = hit.record.Size
	}
	if err := c.accessed(op.ctx, key, hit != nil, bytes); err != nil {
		if hit != nil {
			hit.Close()
		}
		return nil, err
	}
	if hit != nil {
		return hit, nil
	}
	if sizeHint != nil && *sizeHint > c.options.MaxObject {
		c.emit(ctx, "bypass", *sizeHint, 0)
		return nil, &AdmissionError{Code: "object_too_large"}
	}
	token, err := newToken()
	if err != nil {
		return nil, err
	}
	wait, cancelWait := context.WithTimeoutCause(op.ctx, c.fillWait, &AdmissionError{Code: "fill_timeout"})
	defer cancelWait()
	for {
		if wait.Err() != nil {
			return nil, context.Cause(wait)
		}
		owned, err := c.claimFill(wait, key, token)
		if err != nil {
			if wait.Err() != nil {
				return nil, context.Cause(wait)
			}
			return nil, err
		}
		if owned {
			break
		}
		c.emit(ctx, "fill_wait", 0, 0)
		select {
		case <-wait.Done():
			return nil, context.Cause(wait)
		case <-time.After(50 * time.Millisecond):
		}
		hit, err := c.lookup(wait, ctx, key)
		if err != nil {
			return nil, err
		}
		if hit != nil {
			return hit, nil
		}
	}
	cancelWait()
	fillStarted := time.Now()
	defer func() {
		if c.options.Stage != nil {
			c.options.Stage(ctx, "cache_fill", time.Since(fillStarted), err)
		}
	}()
	var candidate *Record
	defer func() {
		if cleanupErr := c.cleanupFill(key, token, candidate); cleanupErr != nil {
			if reader != nil {
				reader.Close()
				reader = nil
			}
			err = errors.Join(err, cleanupErr)
		}
	}()
	work, cancelWork := context.WithTimeoutCause(op.ctx, c.fillTimeout, errFillTimeout)
	defer cancelWork()
	live, cancelLive := context.WithCancelCause(work)
	defer cancelLive(context.Canceled)
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(c.fillHeartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-live.Done():
				return
			case <-ticker.C:
				now := c.now().UnixMilli()
				result, err := c.db.ExecContext(live, "UPDATE fills SET expires=? WHERE key=? AND token=? AND expires>=?", now+readerLease.Milliseconds(), key, token, now)
				if err != nil {
					cancelLive(ErrFillLeaseLost)
					return
				}
				n, err := result.RowsAffected()
				if err != nil || n != 1 {
					cancelLive(ErrFillLeaseLost)
					return
				}
			}
		}
	}()
	defer func() { cancelLive(context.Canceled); <-heartbeatDone }()
	defer func() {
		if err != nil && live.Err() != nil {
			err = context.Cause(live)
		}
	}()
	if hit, err := c.lookup(live, ctx, key); err != nil || hit != nil {
		return hit, err
	}
	if produce == nil {
		return nil, errors.New("cache_producer_required")
	}
	input, err := produce(live)
	if err != nil {
		return nil, err
	}
	if input == nil {
		return nil, errors.New("cache_input_required")
	}
	var closeInput sync.Once
	closeStream := func() { closeInput.Do(func() { input.Close() }) }
	stopClose := context.AfterFunc(live, closeStream)
	defer func() { stopClose(); closeStream() }()
	record, chosen, err := c.spool(live, token, input, verify)
	if err != nil {
		return nil, err
	}
	candidate = &record
	if err := live.Err(); err != nil {
		return nil, context.Cause(live)
	}
	pin, err := c.publish(live, key, token, record, chosen)
	if err != nil {
		return nil, err
	}
	defer c.releaseReader(pin)
	reader, err = c.open(live, ctx, record.Digest, false)
	if err == nil && reader == nil {
		err = errors.New("published_blob_missing")
	}
	return reader, err
}

type checkedReader struct {
	ctx   context.Context
	input io.Reader
}

func (r checkedReader) Read(p []byte) (int, error) {
	if r.ctx.Err() != nil {
		return 0, context.Cause(r.ctx)
	}
	n, err := r.input.Read(p)
	if r.ctx.Err() != nil {
		return n, context.Cause(r.ctx)
	}
	return n, err
}

func (c *Cache) spool(ctx context.Context, token string, input io.Reader, verify Verifier) (record Record, chosen string, err error) {
	raw := "tmp/" + token + ".raw"
	file, err := c.root.OpenFile(raw, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return record, "", err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(checkedReader{ctx, input}, c.options.MaxObject+1))
	if err != nil {
		return record, "", err
	}
	if size > c.options.MaxObject {
		return record, "", &AdmissionError{Code: "object_too_large"}
	}
	if _, err = file.Seek(0, 0); err != nil {
		return record, "", err
	}
	git := sha1.New()
	fmt.Fprintf(git, "blob %d\x00", size)
	if _, err = io.Copy(git, checkedReader{ctx, file}); err != nil {
		return record, "", err
	}
	proof := Proof{GitSHA: hex.EncodeToString(git.Sum(nil)), SHA256: hex.EncodeToString(hash.Sum(nil)), Size: size}
	digest := "sha256-" + proof.SHA256
	if verify != nil {
		digest, err = verify(ctx, proof)
		if err != nil {
			return record, "", err
		}
	}
	if !validDigest.MatchString(digest) || (digest != "git-"+proof.GitSHA && digest != "sha256-"+proof.SHA256) {
		return record, "", errors.New("invalid_verified_digest")
	}
	record = Record{Digest: digest, File: token + ".raw", Size: size, Stored: size, Encoding: "identity", Accessed: c.now().UnixMilli()}
	chosen = raw
	if c.options.Gzip && size >= 1024 {
		if _, err = file.Seek(0, 0); err != nil {
			return record, "", err
		}
		compressed, err := c.root.OpenFile("tmp/"+token+".gz", os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			return record, "", err
		}
		defer compressed.Close()
		started := time.Now()
		writer, err := gzip.NewWriterLevel(compressed, 6)
		if err != nil {
			return record, "", err
		}
		_, copyErr := io.Copy(writer, checkedReader{ctx, file})
		closeErr := writer.Close()
		if copyErr != nil {
			return record, "", copyErr
		}
		if closeErr != nil {
			return record, "", closeErr
		}
		info, err := compressed.Stat()
		if err != nil {
			return record, "", err
		}
		c.transformEvent(ctx, "compress", size, time.Since(started))
		saving := 0.1
		if c.options.Saving != nil {
			saving = *c.options.Saving
		}
		if float64(info.Size()) <= float64(size)*(1-saving) {
			record.Encoding = "gzip"
			record.File = token + ".gz"
			record.Stored = info.Size()
			chosen = "tmp/" + token + ".gz"
			if err := compressed.Sync(); err != nil {
				return record, "", err
			}
		}
	}
	if record.Encoding == "identity" {
		if err := file.Sync(); err != nil {
			return record, "", err
		}
	}
	if ctx.Err() != nil {
		return record, "", context.Cause(ctx)
	}
	return record, chosen, nil
}

func (c *Cache) publish(ctx context.Context, key, token string, record Record, chosen string) (string, error) {
	name, err := blobPath(record)
	if err != nil {
		return "", err
	}
	if err = c.root.MkdirAll(path.Dir(name), 0700); err != nil {
		return "", err
	}
	checkLease := func(tx *sql.Tx) error {
		var alive bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM fills WHERE key=? AND token=? AND expires>?)", key, token, c.now().UnixMilli()).Scan(&alive); err != nil {
			return err
		}
		if !alive {
			return ErrFillLeaseLost
		}
		return nil
	}
	// Commit recovery metadata before rename. A killed publisher leaves this
	// journal and its reservation available to either runtime's recovery code.
	if err := c.transaction(ctx, true, func(tx *sql.Tx) error {
		if err := checkLease(tx); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO publications VALUES(?,?,?)", token, record.Digest, record.File)
		return err
	}); err != nil {
		return "", err
	}
	pin, err := newToken()
	if err != nil {
		return "", err
	}
	duplicate := false
	err = c.transaction(ctx, true, func(tx *sql.Tx) error {
		if err := checkLease(tx); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM blobs WHERE digest=?)", record.Digest).Scan(&duplicate); err != nil {
			return err
		}
		if !duplicate {
			// Keep recovery and lease renewal out of the rename/publication window.
			if err := c.root.Rename(chosen, name); err != nil {
				return err
			}
			file, err := c.root.Open(name)
			if err != nil {
				return err
			}
			allocated, err := allocatedBytes(file)
			file.Close()
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "INSERT INTO blobs VALUES(?,?,?,?,?,?,?)", record.Digest, record.File, record.Size, record.Stored, record.Encoding, c.now().UnixMilli(), allocated); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO aliases VALUES(?,?) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest", key, record.Digest); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM aliases WHERE rowid IN(SELECT rowid FROM aliases ORDER BY rowid LIMIT MAX(0,(SELECT aliases FROM summary WHERE id=1)-200000))`); err != nil {
			return err
		}
		// Pin before releasing the transaction. Maintenance must not evict the blob
		// between publication and opening the caller's reader.
		_, err := tx.ExecContext(ctx, "INSERT INTO readers VALUES(?,?,?)", pin, record.Digest, c.now().Add(readerLease).UnixMilli())
		return err
	})
	if err != nil {
		c.releaseReader(pin)
		return "", err
	}
	if duplicate {
		c.emit(ctx, "deduplicated", record.Stored, 0)
	}
	c.emit(ctx, "fill", record.Size, 0)
	stored := record.Stored
	if duplicate {
		stored = 0
	}
	c.emit(ctx, "stored", stored, 0)
	return pin, nil
}

func (c *Cache) cleanupFill(key, token string, candidate *Record) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return c.transaction(ctx, true, func(tx *sql.Tx) error {
		if candidate != nil {
			var indexed bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM blobs WHERE file=?)", candidate.File).Scan(&indexed); err != nil {
				return err
			}
			if !indexed {
				name, err := blobPath(*candidate)
				if err != nil {
					return err
				}
				if err = c.removePayload(name); err != nil {
					return err
				}
			}
		}
		for _, suffix := range []string{"raw", "gz"} {
			if err := c.removePayload("tmp/" + token + "." + suffix); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM publications WHERE token=?", token); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "DELETE FROM fills WHERE key=? AND token=?", key, token)
		return err
	})
}
