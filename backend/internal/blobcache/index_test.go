package blobcache

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func nodeIndex(t *testing.T, mode, root string) (Stats, *Decision) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("requires Node and repository dependencies")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "../../scripts/test-blob-index.cjs", mode, root)
	out, err := command.Output()
	if err != nil {
		if e, ok := err.(*exec.ExitError); ok {
			t.Fatalf("Node index: %v %s", err, e.Stderr)
		}
		t.Fatal(err)
	}
	var result struct {
		Stats    Stats     `json:"stats"`
		Decision *Decision `json:"decision"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatal(err, string(out))
	}
	return result.Stats, result.Decision
}

func openTestCache(t *testing.T, root string) *Cache {
	t.Helper()
	cache, err := New(t.Context(), Options{Root: root, Budget: 65536, MaxObject: 4096})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cache.Close() })
	return cache
}

func TestNodeIndexInteroperability(t *testing.T) {
	for _, mode := range []string{"seed", "seed-legacy"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			expected, _ := nodeIndex(t, mode, root)
			cache := openTestCache(t, root)
			actual, err := cache.Stats(t.Context())
			if err != nil || !reflect.DeepEqual(actual, expected) {
				t.Fatal(actual, expected, err)
			}
			decision, err := cache.Decision(t.Context(), "node-decision")
			if err != nil || decision == nil || *decision != (Decision{"source-digest", false}) {
				t.Fatal(decision, err)
			}
			if err := cache.SaveDecision(t.Context(), "go-decision", "result-digest", true); err != nil {
				t.Fatal(err)
			}
			nodeStats, nodeDecision := nodeIndex(t, "inspect", root)
			actual, err = cache.Stats(t.Context())
			if err != nil || !reflect.DeepEqual(actual, nodeStats) || nodeDecision == nil || *nodeDecision != (Decision{"result-digest", true}) {
				t.Fatal(actual, nodeStats, nodeDecision, err)
			}
			nodeIndex(t, "mutate", root)
			decision, err = cache.Decision(t.Context(), "go-decision")
			if err != nil || decision == nil || *decision != (Decision{"node-replaced", false}) {
				t.Fatal(decision, err)
			}
			other := openTestCache(t, root)
			reopened, err := other.Stats(t.Context())
			if err != nil || !reflect.DeepEqual(actual, reopened) {
				t.Fatal("reopening reset counters", reopened, actual, err)
			}
			before, err := cache.Stats(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			sentinel := errors.New("rollback")
			err = cache.transaction(t.Context(), true, func(tx *sql.Tx) error {
				if _, err := tx.ExecContext(t.Context(), "DELETE FROM blobs; DELETE FROM fills; DELETE FROM readers; DELETE FROM decisions;"); err != nil {
					return err
				}
				return sentinel
			})
			if !errors.Is(err, sentinel) {
				t.Fatal(err)
			}
			after, err := other.Stats(t.Context())
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatal("rollback changed accounting", before, after, err)
			}
			if err := cache.transaction(t.Context(), true, func(tx *sql.Tx) error {
				_, err := tx.ExecContext(t.Context(), "DELETE FROM blobs; DELETE FROM fills; DELETE FROM readers;")
				return err
			}); err != nil {
				t.Fatal(err)
			}
			final, _ := nodeIndex(t, "inspect", root)
			if final.Blobs != 0 || final.ActiveReaders != 0 || final.ReservedBytes != 0 || final.OldestAccess != nil {
				t.Fatal(final)
			}
		})
	}
}

func TestDecisionExpiryAndAccessThrottle(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	now := time.UnixMilli(1800000000000)
	cache.now = func() time.Time { return now }
	if err := cache.SaveDecision(t.Context(), "rule", "digest", false); err != nil {
		t.Fatal(err)
	}
	initial := now.UnixMilli()
	for _, delta := range []time.Duration{30 * time.Second, time.Millisecond} {
		now = now.Add(delta)
		if value, err := cache.Decision(t.Context(), "rule"); err != nil || value == nil {
			t.Fatal(value, err)
		}
		var accessed int64
		if err := cache.db.QueryRow("SELECT accessed FROM decisions WHERE key='rule'").Scan(&accessed); err != nil {
			t.Fatal(err)
		}
		expected := initial
		if delta == time.Millisecond {
			expected = now.UnixMilli()
		}
		if accessed != expected {
			t.Fatal(accessed, expected)
		}
	}
	now = time.UnixMilli(initial).Add(7 * 24 * time.Hour)
	if value, err := cache.Decision(t.Context(), "rule"); err != nil || value != nil {
		t.Fatal("expired decision served", value, err)
	}
	if err := cache.SaveDecision(t.Context(), "rule", "replacement", true); err != nil {
		t.Fatal(err)
	}
	if value, err := cache.Decision(t.Context(), "rule"); err != nil || value == nil || !value.Changed || value.Digest != "replacement" {
		t.Fatal(value, err)
	}
}

func TestDecisionCapacity(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	_, err := cache.db.Exec(`WITH RECURSIVE entries(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM entries WHERE n<100001)
 INSERT INTO decisions(key,digest,changed,accessed,expires) SELECT 'rule-'||n,'digest',0,n,2000000000000 FROM entries`)
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.SaveDecision(t.Context(), "new-rule", "new-digest", true); err != nil {
		t.Fatal(err)
	}
	stats, err := cache.Stats(t.Context())
	if err != nil || stats.Decisions != 100000 {
		t.Fatal(stats, err)
	}
	var oldest string
	if err := cache.db.QueryRow("SELECT key FROM decisions ORDER BY accessed LIMIT 1").Scan(&oldest); err != nil || oldest != "rule-3" {
		t.Fatal(oldest, err)
	}
}

func TestConcurrentIndexInitialization(t *testing.T) {
	root := t.TempDir()
	var wg sync.WaitGroup
	errors := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Go(func() {
			c, err := New(t.Context(), Options{Root: root, Budget: 65536, MaxObject: 4096})
			if err == nil {
				_, err = c.Stats(t.Context())
				c.Close()
			}
			errors <- err
		})
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	nodeIndex(t, "inspect", root)
}

func TestTransactionDurabilityAndConnectionReplacement(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	sentinel := errors.New("abort")
	for _, durable := range []bool{false, true} {
		err := cache.transaction(t.Context(), durable, func(tx *sql.Tx) error {
			var mode int
			if err := tx.QueryRow("PRAGMA synchronous").Scan(&mode); err != nil {
				return err
			}
			expected := 1
			if durable {
				expected = 2
			}
			if mode != expected {
				t.Errorf("synchronous mode %d, expected %d", mode, expected)
			}
			return sentinel
		})
		if !errors.Is(err, sentinel) {
			t.Fatal(err)
		}
		var mode int
		if err := cache.db.QueryRow("PRAGMA synchronous").Scan(&mode); err != nil || mode != 1 {
			t.Fatal("connection retained FULL mode", mode, err)
		}
	}
	cache.db.SetMaxIdleConns(0)
	// A newly opened connection must not lose connection-local security and
	// transaction settings when database/sql replaces an idle connection.
	for pragma, expected := range map[string]int{"foreign_keys": 1, "recursive_triggers": 1, "busy_timeout": 50, "synchronous": 1} {
		var value int
		if err := cache.db.QueryRow("PRAGMA " + pragma).Scan(&value); err != nil || value != expected {
			t.Fatal(pragma, value, err)
		}
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := cache.SaveDecision(cancelled, "cancelled", "digest", true); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if decision, err := cache.Decision(t.Context(), "cancelled"); err != nil || decision != nil {
		t.Fatal(decision, err)
	}
}

func TestTransactionWaitsForWriterWithoutReplayingCallback(t *testing.T) {
	root := t.TempDir()
	first, second := openTestCache(t, root), openTestCache(t, root)
	for _, cancelWaiting := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelWaiting), func(t *testing.T) {
			holder, err := first.db.BeginTx(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			var calls atomic.Int32
			result := make(chan error, 1)
			sentinel := errors.New("callback failed after side effect")
			go func() { result <- second.transaction(ctx, true, func(*sql.Tx) error { calls.Add(1); return sentinel }) }()
			// Exceed SQLite's 50ms busy timeout while retaining the writer lock.
			time.Sleep(150 * time.Millisecond)
			select {
			case err := <-result:
				t.Fatalf("returned before lock release: %v", err)
			default:
			}
			if cancelWaiting {
				cancel()
			} else if err := holder.Rollback(); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-result:
				if cancelWaiting {
					if !errors.Is(err, context.Canceled) || calls.Load() != 0 {
						t.Fatal(err, calls.Load())
					}
				} else if !errors.Is(err, sentinel) || calls.Load() != 1 {
					t.Fatal(err, calls.Load())
				}
			case <-time.After(3 * time.Second):
				t.Fatal("writer wait did not terminate")
			}
		})
	}
}

func TestInitializationCancellationPreservesExistingIndex(t *testing.T) {
	root := t.TempDir()
	first := openTestCache(t, root)
	if err := first.SaveDecision(t.Context(), "preserved", "source-digest", false); err != nil {
		t.Fatal(err)
	}
	holder, err := first.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback()
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	second, err := New(ctx, Options{Root: root, Budget: 65536, MaxObject: 4096})
	if second != nil {
		second.Close()
		t.Fatal("initialized despite held writer lock")
	}
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > time.Second {
		t.Fatal("initialization ignored cancellation", err, time.Since(started))
	}
	if err := holder.Rollback(); err != nil {
		t.Fatal(err)
	}
	decision, err := first.Decision(t.Context(), "preserved")
	if err != nil || decision == nil || decision.Digest != "source-digest" {
		t.Fatal("failed initialization changed index", decision, err)
	}
}

func TestDecisionReplacementClearsNodeClassification(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	ctx := t.Context()
	if err := cache.SaveDecision(ctx, "decision", "first", false); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.db.ExecContext(ctx, "UPDATE decisions SET isText=1 WHERE key='decision'"); err != nil {
		t.Fatal(err)
	}
	if err := cache.SaveDecision(ctx, "decision", "replacement", true); err != nil {
		t.Fatal(err)
	}
	var classification sql.NullInt64
	if err := cache.db.QueryRowContext(ctx, "SELECT isText FROM decisions WHERE key='decision'").Scan(&classification); err != nil {
		t.Fatal(err)
	}
	if classification.Valid {
		t.Fatal("replacement retained the old Node classification")
	}
}
