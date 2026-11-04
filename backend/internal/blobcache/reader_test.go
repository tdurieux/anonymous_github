package blobcache

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNodeBlobReaders(t *testing.T) {
	root := t.TempDir()
	nodeIndex(t, "seed-readers", root)
	cache := openTestCache(t, root)
	for _, fixture := range []struct{ key, body, encoding string }{{"node-alias", strings.Repeat("shared payload\n", 150), "gzip"}, {"node-identity", "identity payload", "identity"}} {
		t.Run(fixture.encoding, func(t *testing.T) {
			reader, err := cache.Lookup(t.Context(), fixture.key)
			if err != nil || reader == nil {
				t.Fatal(reader, err)
			}
			record := reader.Record()
			if record.Encoding != fixture.encoding {
				t.Fatal(record)
			}
			stats, err := cache.Stats(t.Context())
			if err != nil || stats.ActiveReaders != 1 {
				t.Fatal(stats, err)
			}
			if reader.gzip != nil {
				t.Fatal("decoder initialized before reading")
			}
			data, err := io.ReadAll(reader)
			if err != nil || string(data) != fixture.body {
				t.Fatal(string(data), err)
			}
			if err := reader.Close(); err != nil {
				t.Fatal(err)
			}
			stats, err = cache.Stats(t.Context())
			if err != nil || stats.ActiveReaders != 0 {
				t.Fatal("EOF leaked lease", stats, err)
			}
			raw, err := cache.Open(t.Context(), record.Digest, true)
			if err != nil || raw == nil {
				t.Fatal(raw, err)
			}
			encoded, err := io.ReadAll(raw)
			if err != nil {
				t.Fatal(err)
			}
			if int64(len(encoded)) != record.Stored {
				t.Fatal(len(encoded), record.Stored)
			}
			if fixture.encoding == "gzip" {
				decoder, err := gzip.NewReader(bytes.NewReader(encoded))
				if err != nil {
					t.Fatal(err)
				}
				decoded, err := io.ReadAll(decoder)
				decoder.Close()
				if err != nil || string(decoded) != fixture.body {
					t.Fatal(string(decoded), err)
				}
			} else if string(encoded) != fixture.body {
				t.Fatal(string(encoded))
			}
		})
	}
	pinned, err := cache.Lookup(t.Context(), "node-alias")
	if err != nil || pinned == nil {
		t.Fatal(pinned, err)
	}
	stats, _ := nodeIndex(t, "evict", root)
	if stats.Blobs != 1 || stats.ActiveReaders != 1 {
		t.Fatal("Node ignored Go reader pin", stats)
	}
	data, err := io.ReadAll(pinned)
	if err != nil || string(data) != strings.Repeat("shared payload\n", 150) {
		t.Fatal(len(data), err)
	}
	stats, _ = nodeIndex(t, "evict", root)
	if stats.Blobs != 0 || stats.ActiveReaders != 0 {
		t.Fatal("released pin prevented eviction", stats)
	}
	if miss, err := cache.Lookup(t.Context(), "node-alias"); err != nil || miss != nil {
		t.Fatal(miss, err)
	}
}

func seedBlob(t *testing.T, c *Cache, body []byte, compressed bool) Record {
	t.Helper()
	sum := sha256.Sum256(body)
	record := Record{Digest: "sha256-" + hex.EncodeToString(sum[:]), File: "aaaaaaaa.raw", Size: int64(len(body)), Encoding: "identity", Allocated: 4096, Accessed: time.Now().Add(-time.Minute).UnixMilli()}
	stored := body
	if compressed {
		var out bytes.Buffer
		writer := gzip.NewWriter(&out)
		writer.Write(body)
		writer.Close()
		stored = out.Bytes()
		record.Encoding = "gzip"
		record.File = "aaaaaaaa.gz"
	}
	record.Stored = int64(len(stored))
	name, err := blobPath(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.root.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	file, err := c.root.OpenFile(name, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(stored); err != nil {
		t.Fatal(err)
	}
	file.Close()
	if _, err := c.db.Exec("INSERT INTO blobs VALUES(?,?,?,?,?,?,?)", record.Digest, record.File, record.Size, record.Stored, record.Encoding, record.Accessed, record.Allocated); err != nil {
		t.Fatal(err)
	}
	if _, err := c.db.Exec("INSERT INTO aliases VALUES(?,?)", "alias", record.Digest); err != nil {
		t.Fatal(err)
	}
	return record
}

func TestReaderLeaseLifecycle(t *testing.T) {
	for _, action := range []string{"close", "cancel", "lease-lost", "lease-expired", "cache-close"} {
		t.Run(action, func(t *testing.T) {
			cache := openTestCache(t, t.TempDir())
			cache.readerHeartbeat = 10 * time.Millisecond
			record := seedBlob(t, cache, []byte("payload"), false)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			reader, err := cache.Open(ctx, record.Digest, false)
			if err != nil || reader == nil {
				t.Fatal(reader, err)
			}
			var before int64
			if err := cache.db.QueryRow("SELECT expires FROM readers WHERE token=?", reader.token).Scan(&before); err != nil {
				t.Fatal(err)
			}
			deadline := time.After(2 * time.Second)
			for {
				var renewed int64
				if err := cache.db.QueryRow("SELECT expires FROM readers WHERE token=?", reader.token).Scan(&renewed); err != nil {
					t.Fatal(err)
				}
				if renewed > before {
					break
				}
				select {
				case <-deadline:
					t.Fatal("reader lease did not renew")
				case <-time.After(time.Millisecond):
				}
			}
			expected := error(os.ErrClosed)
			switch action {
			case "close":
				reader.Close()
			case "cancel":
				cancel()
				expected = context.Canceled
			case "lease-lost":
				if _, err := cache.db.Exec("DELETE FROM readers WHERE token=?", reader.token); err != nil {
					t.Fatal(err)
				}
				expected = ErrReaderLeaseLost
			case "lease-expired":
				if _, err := cache.db.Exec("UPDATE readers SET expires=0 WHERE token=?", reader.token); err != nil {
					t.Fatal(err)
				}
				expected = ErrReaderLeaseLost
			case "cache-close":
				if err := cache.Close(); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-reader.done:
			case <-time.After(2 * time.Second):
				t.Fatal("reader did not stop")
			}
			if _, err := reader.Read(make([]byte, 3)); !errors.Is(err, expected) {
				t.Fatal(err, expected)
			}
			reader.Close()
			if action == "cache-close" {
				other := openTestCache(t, cache.options.Root)
				stats, err := other.Stats(t.Context())
				if err != nil || stats.ActiveReaders != 0 {
					t.Fatal(stats, err)
				}
				if r, err := cache.Open(t.Context(), record.Digest, false); !errors.Is(err, os.ErrClosed) || r != nil {
					t.Fatal(r, err)
				}
			} else {
				stats, err := cache.Stats(t.Context())
				if err != nil || stats.ActiveReaders != 0 {
					t.Fatal(stats, err)
				}
			}
		})
	}
}

func TestReaderCorruptionAndConfinement(t *testing.T) {
	for _, kind := range []string{"missing", "short", "directory", "symlink", "gzip-header", "gzip-checksum", "expanded-size", "decoded-short", "unsafe-name"} {
		t.Run(kind, func(t *testing.T) {
			cache := openTestCache(t, t.TempDir())
			record := seedBlob(t, cache, bytes.Repeat([]byte("content"), 200), strings.HasPrefix(kind, "gzip") || kind == "expanded-size" || kind == "decoded-short")
			name, _ := blobPath(record)
			var outside string
			switch kind {
			case "missing":
				cache.root.Remove(name)
			case "short":
				if err := os.Truncate(filepath.Join(cache.options.Root, name), 1); err != nil {
					t.Fatal(err)
				}
			case "directory":
				cache.root.Remove(name)
				cache.root.MkdirAll(name, 0700)
			case "symlink":
				outside = filepath.Join(t.TempDir(), "private")
				if err := os.WriteFile(outside, []byte("secret"), 0600); err != nil {
					t.Fatal(err)
				}
				cache.root.Remove(name)
				if err := os.Symlink(outside, filepath.Join(cache.options.Root, name)); err != nil {
					t.Fatal(err)
				}
			case "gzip-header", "gzip-checksum":
				data, err := os.ReadFile(filepath.Join(cache.options.Root, name))
				if err != nil {
					t.Fatal(err)
				}
				offset := 0
				if kind == "gzip-checksum" {
					offset = len(data) - 8
				}
				data[offset] ^= 0xff
				if err := os.WriteFile(filepath.Join(cache.options.Root, name), data, 0600); err != nil {
					t.Fatal(err)
				}
			case "expanded-size":
				if _, err := cache.db.Exec("UPDATE blobs SET size=1"); err != nil {
					t.Fatal(err)
				}
			case "decoded-short":
				if _, err := cache.db.Exec("UPDATE blobs SET size=size+1"); err != nil {
					t.Fatal(err)
				}
			case "unsafe-name":
				if _, err := cache.db.Exec("UPDATE blobs SET file='../escape.raw'"); err != nil {
					t.Fatal(err)
				}
			}
			reader, err := cache.Open(t.Context(), record.Digest, false)
			if kind == "unsafe-name" {
				if !errors.Is(err, ErrInvalidRecord) || reader != nil {
					t.Fatal(reader, err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if reader != nil {
					data, err := io.ReadAll(reader)
					reader.Close()
					if err == nil {
						t.Fatal("corrupt body accepted", len(data))
					}
					if kind == "expanded-size" && len(data) > 1 {
						t.Fatal("decompression exceeded declared size", len(data))
					}
				}
				stats, err := cache.Stats(t.Context())
				if err != nil || stats.Blobs != 0 || stats.ActiveReaders != 0 {
					t.Fatal("corruption retained", stats, err)
				}
				if reader, err := cache.Lookup(t.Context(), "alias"); err != nil || reader != nil {
					t.Fatal(reader, err)
				}
			}
			if outside != "" {
				data, err := os.ReadFile(outside)
				if err != nil || string(data) != "secret" {
					t.Fatal("escaped cache root", string(data), err)
				}
			}
		})
	}
}

func TestReaderConcurrentCloseAndRead(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	record := seedBlob(t, cache, bytes.Repeat([]byte("read"), 10000), true)
	for i := 0; i < 20; i++ {
		reader, err := cache.Open(t.Context(), record.Digest, false)
		if err != nil || reader == nil {
			t.Fatal(reader, err)
		}
		var work sync.WaitGroup
		work.Go(func() { io.Copy(io.Discard, reader) })
		work.Go(func() { reader.Close() })
		work.Go(func() { reader.Close() })
		work.Wait()
	}
	stats, err := cache.Stats(t.Context())
	if err != nil || stats.ActiveReaders != 0 {
		t.Fatal(stats, err)
	}
}

func TestDiscardOldRepresentationPreservesReplacement(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	old := seedBlob(t, cache, []byte("replacement-safe"), false)
	replacement := old
	replacement.File = "bbbbbbbb.raw"
	name, err := blobPath(replacement)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache.options.Root, name), []byte("replacement-safe"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.db.Exec("UPDATE blobs SET file=? WHERE digest=?", replacement.File, old.Digest); err != nil {
		t.Fatal(err)
	}
	if err := cache.discardRecord(t.Context(), old); err != nil {
		t.Fatal(err)
	}
	reader, err := cache.Lookup(t.Context(), "alias")
	if err != nil || reader == nil {
		t.Fatal("replacement removed", reader, err)
	}
	data, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || string(data) != "replacement-safe" {
		t.Fatal(string(data), err)
	}
}

func TestCacheCloseDuringOpens(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	record := seedBlob(t, cache, bytes.Repeat([]byte("data"), 1000), true)
	pinned, err := cache.Open(t.Context(), record.Digest, false)
	if err != nil || pinned == nil {
		t.Fatal(pinned, err)
	}
	start := make(chan struct{})
	var work sync.WaitGroup
	for i := 0; i < 20; i++ {
		work.Go(func() {
			<-start
			reader, err := cache.Open(t.Context(), record.Digest, false)
			if errors.Is(err, os.ErrClosed) {
				return
			}
			if err != nil || reader == nil {
				t.Error(reader, err)
				return
			}
			_, err = io.Copy(io.Discard, reader)
			if err != nil && !errors.Is(err, os.ErrClosed) {
				t.Error(err)
			}
			reader.Close()
		})
	}
	work.Go(func() {
		<-start
		if err := cache.Close(); err != nil {
			t.Error(err)
		}
	})
	close(start)
	work.Wait()
	pinned.Close()
	other := openTestCache(t, cache.options.Root)
	stats, err := other.Stats(t.Context())
	if err != nil || stats.ActiveReaders != 0 || stats.Blobs != 1 {
		t.Fatal(stats, err)
	}
}
