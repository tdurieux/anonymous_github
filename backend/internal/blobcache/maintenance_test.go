package blobcache

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func writeCacheFile(t *testing.T, c *Cache, name string, old bool) {
	t.Helper()
	if err := c.root.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	file, err := c.root.OpenFile(name, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("payload"); err != nil {
		t.Fatal(err)
	}
	file.Close()
	if old {
		stamp := c.now().Add(-2 * time.Hour)
		if err := os.Chtimes(filepath.Join(c.options.Root, name), stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
}

func countRows(t *testing.T, c *Cache, table string) int {
	t.Helper()
	var count int
	if err := c.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestNodeMaintenanceParity(t *testing.T) {
	nodeRoot, goRoot := t.TempDir(), t.TempDir()
	nodeIndex(t, "seed-maintenance", nodeRoot)
	nodeIndex(t, "seed-maintenance", goRoot)
	expected, _ := nodeIndex(t, "maintain", nodeRoot)
	cache := openTestCache(t, goRoot)
	cache.options.Budget = 4096
	if err := cache.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	actual, err := cache.Stats(t.Context())
	if err != nil || !reflect.DeepEqual(actual, expected) {
		t.Fatal(actual, expected, err)
	}
	for _, key := range []string{"node-alias", "node-identity", "node-third"} {
		var evicted int
		if err := cache.db.QueryRow("SELECT evicted FROM history WHERE key=?", key).Scan(&evicted); err != nil {
			t.Fatal(err)
		}
		expected := 1
		if key == "node-third" {
			expected = 0
		}
		if evicted != expected {
			t.Fatal(key, evicted, expected)
		}
	}
	nodeIndex(t, "inspect", goRoot)
}

func TestMaintenanceHonorsReadersAndReservations(t *testing.T) {
	root := t.TempDir()
	nodeIndex(t, "seed-maintenance", root)
	cache := openTestCache(t, root)
	reader, err := cache.Lookup(t.Context(), "node-alias")
	if err != nil || reader == nil {
		t.Fatal(reader, err)
	}
	defer reader.Close()
	// The live reservation consumes the entire budget. Only the reader-pinned
	// blob may remain; maintenance cannot reclaim that space yet.
	if _, err := cache.db.Exec("INSERT INTO fills VALUES('live','live-token',?,65536)", time.Now().Add(time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := cache.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	stats, err := cache.Stats(t.Context())
	if err != nil || stats.Blobs != 1 || stats.ActiveReaders != 1 || stats.ReservedBytes != 65536 {
		t.Fatal(stats, err)
	}
	reader.Close()
	if err := cache.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	stats, err = cache.Stats(t.Context())
	if err != nil || stats.Blobs != 0 || stats.ReservedBytes != 65536 {
		t.Fatal(stats, err)
	}
}

func TestExpiredFillRecovery(t *testing.T) {
	for _, kind := range []string{"unindexed", "indexed", "blocked-spool", "blocked-publication", "unsafe-token", "unsafe-publication"} {
		t.Run(kind, func(t *testing.T) {
			cache := openTestCache(t, t.TempDir())
			record := seedBlob(t, cache, []byte("published"), false)
			token := "dead-token"
			file := "dead.raw"
			digest := record.Digest
			if kind == "indexed" {
				file = record.File
			}
			if kind == "unsafe-token" {
				token = "../../outside"
			}
			if kind == "unsafe-publication" {
				file = "../../outside.raw"
			}
			name, _ := blobLocation(digest, "dead.raw")
			if kind != "indexed" {
				writeCacheFile(t, cache, name, false)
			}
			if kind == "blocked-publication" {
				cache.root.Remove(name)
				cache.root.MkdirAll(name, 0700)
			}
			if kind != "unsafe-token" {
				writeCacheFile(t, cache, "tmp/"+token+".raw", false)
				writeCacheFile(t, cache, "tmp/"+token+".gz", false)
			}
			if kind == "blocked-spool" {
				cache.root.Remove("tmp/" + token + ".raw")
				cache.root.MkdirAll("tmp/"+token+".raw", 0700)
			}
			if _, err := cache.db.Exec("INSERT INTO fills VALUES('dead',?,?,13312)", token, time.Now().Add(-time.Second).UnixMilli()); err != nil {
				t.Fatal(err)
			}
			if _, err := cache.db.Exec("INSERT INTO publications VALUES(?,?,?)", token, digest, file); err != nil {
				t.Fatal(err)
			}
			err := cache.Maintain(t.Context())
			failed := strings.HasPrefix(kind, "blocked") || strings.HasPrefix(kind, "unsafe")
			if failed {
				if err == nil {
					t.Fatal("failed file deletion released reservation")
				}
				stats, statsErr := cache.Stats(t.Context())
				if statsErr != nil || stats.ReservedBytes != 13312 || countRows(t, cache, "publications") != 1 {
					t.Fatal(stats, statsErr)
				}
				if strings.HasPrefix(kind, "unsafe") {
					return
				}
				if kind == "blocked-spool" {
					cache.root.Remove("tmp/" + token + ".raw")
				} else {
					cache.root.Remove(name)
				}
				err = cache.Maintain(t.Context())
			}
			if err != nil {
				t.Fatal(err)
			}
			stats, err := cache.Stats(t.Context())
			if err != nil || stats.ReservedBytes != 0 || countRows(t, cache, "publications") != 0 || stats.Blobs != 1 {
				t.Fatal(stats, err)
			}
			for _, suffix := range []string{"raw", "gz"} {
				if _, err := cache.root.Lstat("tmp/" + token + "." + suffix); !os.IsNotExist(err) {
					t.Fatal("spool survived", suffix, err)
				}
			}
			reader, err := cache.Open(t.Context(), record.Digest, false)
			if err != nil || reader == nil {
				t.Fatal("indexed publication removed", reader, err)
			}
			reader.Close()
		})
	}
}

func TestMaintenanceExpiryBoundariesAndBatches(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	now := time.Now().Truncate(time.Millisecond)
	cache.now = func() time.Time { return now }
	err := cache.transaction(t.Context(), false, func(tx *sql.Tx) error {
		for i := 0; i < 300; i++ {
			if _, err := tx.Exec("INSERT INTO fills VALUES(?,?,?,1)", fmt.Sprint(i), fmt.Sprintf("token-%d", i), now.UnixMilli()-1); err != nil {
				return err
			}
			if _, err := tx.Exec("INSERT INTO decisions(key,digest,changed,accessed,expires) VALUES(?,'digest',0,0,?)", fmt.Sprint(i), now.UnixMilli()-1); err != nil {
				return err
			}
			if _, err := tx.Exec("INSERT INTO history VALUES(?,?,0)", fmt.Sprint(i), now.Add(-7*24*time.Hour).UnixMilli()-1); err != nil {
				return err
			}
		}
		for _, stamp := range []int64{now.UnixMilli() - 1, now.UnixMilli(), now.UnixMilli() + 1} {
			if _, err := tx.Exec("INSERT INTO readers VALUES(?,'digest',?)", fmt.Sprint(stamp), stamp); err != nil {
				return err
			}
		}
		_, err := tx.Exec("INSERT INTO fills VALUES('boundary','boundary',?,1)", now.UnixMilli())
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if countRows(t, cache, "fills") != 1 || countRows(t, cache, "readers") != 2 || countRows(t, cache, "decisions") != 44 || countRows(t, cache, "history") != 44 {
		t.Fatal("incorrect expiry boundary or batch")
	}
	if err := cache.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if countRows(t, cache, "decisions") != 0 || countRows(t, cache, "history") != 0 {
		t.Fatal("second batch not reclaimed")
	}
}

func TestMaintenanceOrphanScan(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	now := time.Now()
	cache.now = func() time.Time { return now }
	record := seedBlob(t, cache, []byte("indexed"), false)
	indexed, _ := blobPath(record)
	stamp := now.Add(-2 * time.Hour)
	os.Chtimes(filepath.Join(cache.options.Root, indexed), stamp, stamp)
	old, _ := blobLocation(record.Digest, "dead.raw")
	fresh, _ := blobLocation(record.Digest, "beef.raw")
	live, _ := blobLocation(record.Digest, "feed.raw")
	writeCacheFile(t, cache, old, true)
	writeCacheFile(t, cache, fresh, false)
	writeCacheFile(t, cache, live, true)
	if _, err := cache.db.Exec("INSERT INTO fills VALUES('live','live-token',?,1)", now.Add(3*time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.db.Exec("INSERT INTO publications VALUES('live-token',?,?)", record.Digest, "feed.raw"); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "private"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(cache.options.Root, "blobs", "outside")); err != nil {
		t.Fatal(err)
	}
	if err := cache.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.root.Lstat(old); !os.IsNotExist(err) {
		t.Fatal("orphan retained", err)
	}
	for _, name := range []string{indexed, fresh, live} {
		if _, err := cache.root.Lstat(name); err != nil {
			t.Fatal("live file removed", name, err)
		}
	}
	if data, err := os.ReadFile(filepath.Join(outside, "private")); err != nil || string(data) != "private" {
		t.Fatal("followed directory symlink", err)
	}
	writeCacheFile(t, cache, old, true)
	if err := cache.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.root.Lstat(old); err != nil {
		t.Fatal("hourly claim ignored", err)
	}
	now = now.Add(time.Hour)
	if err := cache.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.root.Lstat(old); !os.IsNotExist(err) {
		t.Fatal("next scan skipped", err)
	}
	if _, err := cache.root.Lstat(live); err != nil {
		t.Fatal("active publication deleted", err)
	}
}

func TestFailedOrphanScanCanRetry(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	writeCacheFile(t, cache, "blobs", false)
	if err := cache.Maintain(t.Context()); err == nil {
		t.Fatal("non-directory scan accepted")
	}
	var next int64
	if err := cache.db.QueryRow("SELECT nextScan FROM maintenance WHERE id=1").Scan(&next); err != nil || next > time.Now().UnixMilli() {
		t.Fatal("failed scan retained claim", next, err)
	}
	cache.root.Remove("blobs")
	name := "blobs/orphan.raw"
	writeCacheFile(t, cache, name, true)
	if err := cache.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.root.Lstat(name); !os.IsNotExist(err) {
		t.Fatal("retry skipped orphan", err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := cache.Maintain(cancelled); err == nil {
		t.Fatal("cancelled cleanup ran")
	}
}

func TestEvictionBatchLimitAndDeletionFailure(t *testing.T) {
	t.Run("bounded batch", func(t *testing.T) {
		cache := openTestCache(t, t.TempDir())
		cache.options.Budget = 1
		if err := cache.transaction(t.Context(), false, func(tx *sql.Tx) error {
			for i := 1; i <= 513; i++ {
				record := Record{Digest: fmt.Sprintf("sha256-%064x", i), File: fmt.Sprintf("%064x.raw", i), Size: 7, Stored: 7, Allocated: 4096, Encoding: "identity", Accessed: int64(i)}
				name, err := blobPath(record)
				if err != nil {
					return err
				}
				writeCacheFile(t, cache, name, false)
				if _, err := tx.Exec("INSERT INTO blobs VALUES(?,?,?,?,?,?,?)", record.Digest, record.File, record.Size, record.Stored, record.Encoding, record.Accessed, record.Allocated); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if err := cache.Maintain(t.Context()); err != nil {
			t.Fatal(err)
		}
		stats, err := cache.Stats(t.Context())
		if err != nil || stats.Blobs != 1 || stats.AllocatedBytes != 4096 || stats.OldestAccess == nil || *stats.OldestAccess != 513 {
			t.Fatal(stats, err)
		}
		if err := cache.Maintain(t.Context()); err != nil {
			t.Fatal(err)
		}
		stats, err = cache.Stats(t.Context())
		if err != nil || stats.Blobs != 0 || stats.AllocatedBytes != 0 {
			t.Fatal(stats, err)
		}
	})
	t.Run("failed deletion retains accounting and tries later candidates", func(t *testing.T) {
		cache := openTestCache(t, t.TempDir())
		cache.options.Budget = 4096
		bad := seedBlob(t, cache, []byte("bad"), false)
		if _, err := cache.db.Exec("UPDATE aliases SET key='bad'"); err != nil {
			t.Fatal(err)
		}
		seedBlob(t, cache, []byte("good"), false)
		name, _ := blobPath(bad)
		cache.root.Remove(name)
		cache.root.MkdirAll(name, 0700)
		if err := cache.Maintain(t.Context()); err != nil {
			t.Fatal(err)
		}
		stats, err := cache.Stats(t.Context())
		if err != nil || stats.Blobs != 1 || stats.AllocatedBytes != 4096 {
			t.Fatal(stats, err)
		}
		var retained string
		if err := cache.db.QueryRow("SELECT digest FROM blobs").Scan(&retained); err != nil || retained != bad.Digest {
			t.Fatal(retained, err)
		}
	})
}

func TestOrphanScanRejectsSymlinkRoot(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	// Even an in-root link must not redirect the blob scan into index or spool
	// files. Nested links are unlinked as entries, never traversed.
	if err := os.Symlink(".", filepath.Join(cache.options.Root, "blobs")); err != nil {
		t.Fatal(err)
	}
	if err := cache.Maintain(t.Context()); err == nil {
		t.Fatal("followed symlink scan root")
	}
	if _, err := cache.Stats(t.Context()); err != nil {
		t.Fatal("index damaged", err)
	}
}

func TestRecoverKilledNodePublisher(t *testing.T) {
	root := t.TempDir()
	before, _ := nodeIndex(t, "crash-publisher", root)
	if before.ReservedBytes == 0 || before.Blobs != 0 {
		t.Fatal("publisher did not stop before indexing", before)
	}
	cache := openTestCache(t, root)
	var digest, file string
	if err := cache.db.QueryRow("SELECT digest,file FROM publications").Scan(&digest, &file); err != nil {
		t.Fatal(err)
	}
	name, err := blobLocation(digest, file)
	if err != nil {
		t.Fatal(err)
	}
	if info, err := cache.root.Stat(name); err != nil || info.Size() == 0 {
		t.Fatal("renamed payload missing", err)
	}
	if err := cache.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.root.Stat(name); !os.IsNotExist(err) {
		t.Fatal("crashed publication retained", err)
	}
	after, err := cache.Stats(t.Context())
	if err != nil || after.ReservedBytes != 0 || after.Blobs != 0 || countRows(t, cache, "publications") != 0 {
		t.Fatal(after, err)
	}
	nodeIndex(t, "refill", root)
	reader, err := cache.Lookup(t.Context(), "multiprocess")
	if err != nil || reader == nil {
		t.Fatal(reader, err)
	}
	data, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || string(data) != "recovered" {
		t.Fatal(string(data), err)
	}
}
