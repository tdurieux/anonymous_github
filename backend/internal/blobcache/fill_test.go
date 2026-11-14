package blobcache

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func producer(body string) Producer {
	return func(context.Context) (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(body)), nil }
}
func readFilled(t *testing.T, reader *Reader, err error) string {
	t.Helper()
	if err != nil || reader == nil {
		t.Fatal(reader, err)
	}
	data, err := io.ReadAll(reader)
	reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
func assertFillClean(t *testing.T, c *Cache) {
	t.Helper()
	stats, err := c.Stats(t.Context())
	if err != nil || stats.ReservedBytes != 0 || stats.ActiveReaders != 0 || countRows(t, c, "fills") != 0 || countRows(t, c, "publications") != 0 {
		t.Fatal("fill state leaked", stats, err)
	}
	file, err := c.root.Open("tmp")
	if err != nil {
		t.Fatal(err)
	}
	entries, err := file.ReadDir(-1)
	file.Close()
	if err != nil || len(entries) != 0 {
		t.Fatal("spools leaked", entries, err)
	}
}

func TestFillPublicationAndDeduplication(t *testing.T) {
	cache := openTestCache(t, t.TempDir())
	cache.options.Gzip = true
	var eventsMu sync.Mutex
	events := map[string]int{}
	cache.options.Observe = func(event Event) { eventsMu.Lock(); events[event.Name]++; eventsMu.Unlock() }
	body := strings.Repeat("go shared payload\n", 150)
	verify := func(ctx context.Context, proof Proof) (string, error) {
		if proof.Size != int64(len(body)) || len(proof.GitSHA) != 40 || len(proof.SHA256) != 64 {
			t.Error(proof)
		}
		return "git-" + proof.GitSHA, nil
	}
	reader, err := cache.GetOrFill(t.Context(), "go-alias", producer(body), verify, nil)
	if err != nil || reader == nil {
		t.Fatal(reader, err)
	}
	record := reader.Record()
	if record.Encoding != "gzip" || record.Stored >= record.Size {
		t.Fatal(record)
	}
	if got := readFilled(t, reader, nil); got != body {
		t.Fatal(got)
	}
	reader, err = cache.GetOrFill(t.Context(), "second-alias", producer(body), verify, nil)
	if got := readFilled(t, reader, err); got != body {
		t.Fatal(got)
	}
	stats, err := cache.Stats(t.Context())
	if err != nil || stats.Blobs != 1 || countRows(t, cache, "aliases") != 2 {
		t.Fatal(stats, err)
	}
	// A hit must outlive the fill operation's internal cancellation and must not
	// invoke a producer, even when its stale hint exceeds current admission limits.
	hint := cache.options.MaxObject + 1
	reader, err = cache.GetOrFill(t.Context(), "go-alias", func(context.Context) (io.ReadCloser, error) { t.Error("producer called on hit"); return nil, nil }, nil, &hint)
	if got := readFilled(t, reader, err); got != body {
		t.Fatal(got)
	}
	assertFillClean(t, cache)
	eventsMu.Lock()
	defer eventsMu.Unlock()
	for _, name := range []string{"source_fill", "source_deduplicated", "source_hit", "source_miss", "compress", "decompress", "source_reuse_1h"} {
		if events[name] == 0 {
			t.Error("missing metric", name, events)
		}
	}
}

func TestFillFailuresAndAdmission(t *testing.T) {
	for _, kind := range []string{"large-hint", "large-stream", "producer", "verify", "false-digest", "invalid-digest", "budget", "disk", "timeout", "wait-timeout", "lease-lost"} {
		t.Run(kind, func(t *testing.T) {
			cache := openTestCache(t, t.TempDir())
			produce := producer("data")
			var verify Verifier
			var hint *int64
			sentinel := errors.New("fixture_failure")
			switch kind {
			case "large-hint":
				n := cache.options.MaxObject + 1
				hint = &n
				produce = func(context.Context) (io.ReadCloser, error) { t.Error("oversized hint produced"); return nil, nil }
			case "large-stream":
				produce = producer(strings.Repeat("x", int(cache.options.MaxObject+1)))
			case "producer":
				produce = func(context.Context) (io.ReadCloser, error) { return nil, sentinel }
			case "verify":
				verify = func(context.Context, Proof) (string, error) { return "", sentinel }
			case "false-digest":
				verify = func(context.Context, Proof) (string, error) { return "sha256-" + strings.Repeat("0", 64), nil }
			case "invalid-digest":
				verify = func(context.Context, Proof) (string, error) { return "../outside", nil }
			case "budget":
				cache.options.Budget = 1
			case "disk":
				cache.options.FreeBytes = math.MaxInt64
			case "timeout":
				cache.fillTimeout = 30 * time.Millisecond
				produce = func(ctx context.Context) (io.ReadCloser, error) { <-ctx.Done(); return nil, ctx.Err() }
			case "wait-timeout":
				cache.fillWait = 30 * time.Millisecond
				if _, err := cache.db.Exec("INSERT INTO fills VALUES('key','foreign',?,1)", time.Now().Add(time.Hour).UnixMilli()); err != nil {
					t.Fatal(err)
				}
			case "lease-lost":
				verify = func(ctx context.Context, proof Proof) (string, error) {
					_, err := cache.db.Exec("UPDATE fills SET expires=1 WHERE key='key'")
					return "sha256-" + proof.SHA256, err
				}
			}
			reader, err := cache.GetOrFill(t.Context(), "key", produce, verify, hint)
			if err == nil || reader != nil {
				t.Fatal("failure published", reader, err)
			}
			if kind == "timeout" && !errors.Is(err, errFillTimeout) {
				t.Fatal(err)
			}
			if kind == "lease-lost" && !errors.Is(err, ErrFillLeaseLost) {
				t.Fatal(err)
			}
			if kind == "producer" || kind == "verify" {
				if !errors.Is(err, sentinel) {
					t.Fatal(err)
				}
			}
			if kind == "large-hint" || kind == "large-stream" || kind == "budget" || kind == "disk" || kind == "wait-timeout" {
				var admission *AdmissionError
				if !errors.As(err, &admission) {
					t.Fatal("not an admission error", err)
				}
			}
			if countRows(t, cache, "blobs") != 0 || countRows(t, cache, "aliases") != 0 {
				t.Fatal("failed content indexed")
			}
			if kind == "wait-timeout" {
				if countRows(t, cache, "fills") != 1 {
					t.Fatal("foreign fill removed")
				}
				cache.db.Exec("DELETE FROM fills")
			}
			assertFillClean(t, cache)
		})
	}
}

func TestFillCoordinationAcrossConnections(t *testing.T) {
	root := t.TempDir()
	first := openTestCache(t, root)
	second := openTestCache(t, root)
	var calls atomic.Int64
	produce := func(ctx context.Context) (io.ReadCloser, error) {
		calls.Add(1)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
			return io.NopCloser(strings.NewReader("one producer")), nil
		}
	}
	start := make(chan struct{})
	var work sync.WaitGroup
	for i := 0; i < 6; i++ {
		cache := first
		if i%2 != 0 {
			cache = second
		}
		work.Go(func() {
			<-start
			reader, err := cache.GetOrFill(t.Context(), "shared-key", produce, nil, nil)
			if err != nil || reader == nil {
				t.Error(reader, err)
				return
			}
			data, err := io.ReadAll(reader)
			reader.Close()
			if err != nil || string(data) != "one producer" {
				t.Error(string(data), err)
			}
		})
	}
	close(start)
	work.Wait()
	if calls.Load() != 1 {
		t.Fatal("duplicate producers", calls.Load())
	}
	assertFillClean(t, first)
}

func TestCacheCloseCancelsFill(t *testing.T) {
	for _, blocked := range []string{"producer", "stream", "verifier"} {
		t.Run(blocked, func(t *testing.T) {
			cache := openTestCache(t, t.TempDir())
			entered := make(chan struct{})
			done := make(chan error, 1)
			produce := producer("data")
			var verify Verifier
			switch blocked {
			case "producer":
				produce = func(ctx context.Context) (io.ReadCloser, error) { close(entered); <-ctx.Done(); return nil, ctx.Err() }
			case "stream":
				input, output := io.Pipe()
				defer output.Close()
				produce = func(context.Context) (io.ReadCloser, error) { close(entered); return input, nil }
			case "verifier":
				verify = func(ctx context.Context, proof Proof) (string, error) {
					close(entered)
					<-ctx.Done()
					return "", ctx.Err()
				}
			}
			go func() {
				reader, err := cache.GetOrFill(t.Context(), "key", produce, verify, nil)
				if reader != nil {
					reader.Close()
				}
				done <- err
			}()
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("fill did not enter")
			}
			closed := make(chan error, 1)
			go func() { closed <- cache.Close() }()
			select {
			case err := <-closed:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("cache close blocked")
			}
			if err := <-done; !errors.Is(err, os.ErrClosed) {
				t.Fatal(err)
			}
			other := openTestCache(t, cache.options.Root)
			assertFillClean(t, other)
		})
	}
}

func TestFillIdentityAndSizeBoundaries(t *testing.T) {
	for _, size := range []int{0, 1023, 1024, 4096} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			cache := openTestCache(t, t.TempDir())
			cache.options.Gzip = true
			body := bytes.Repeat([]byte("x"), size)
			reader, err := cache.GetOrFill(t.Context(), "key", producer(string(body)), nil, nil)
			if err != nil || reader == nil {
				t.Fatal(reader, err)
			}
			if size < 1024 && reader.Record().Encoding != "identity" {
				t.Fatal(reader.Record())
			}
			if got := readFilled(t, reader, nil); got != string(body) {
				t.Fatal(len(got), size)
			}
			assertFillClean(t, cache)
		})
	}
}

func TestFillNodeReadsGoPublications(t *testing.T) {
	root := t.TempDir()
	cache := openTestCache(t, root)
	cache.options.Gzip = true
	for _, fixture := range []struct {
		key, body string
		git       bool
	}{
		{"go-identity", "identity from Go", true},
		{"go-gzip", strings.Repeat("Go gzip payload\n", 150), false},
	} {
		var verify Verifier
		if fixture.git {
			verify = func(_ context.Context, proof Proof) (string, error) { return "git-" + proof.GitSHA, nil }
		}
		reader, err := cache.GetOrFill(t.Context(), fixture.key, producer(fixture.body), verify, nil)
		if got := readFilled(t, reader, err); got != fixture.body {
			t.Fatal(got)
		}
	}
	assertFillClean(t, cache)
	nodeStats, _ := nodeIndex(t, "read-go", root)
	goStats, err := cache.Stats(t.Context())
	if err != nil || !reflect.DeepEqual(nodeStats, goStats) {
		t.Fatal(nodeStats, goStats, err)
	}
	assertFillClean(t, cache)
}

func TestFillNodeWaitsForGoProducer(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("requires Node")
	}
	root := t.TempDir()
	cache := openTestCache(t, root)
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	completed := make(chan error, 1)
	go func() {
		reader, err := cache.GetOrFill(t.Context(), "shared-process-key", func(ctx context.Context) (io.ReadCloser, error) {
			close(entered)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
			}
			return io.NopCloser(strings.NewReader("one cross-process producer")), nil
		}, nil, nil)
		if err == nil {
			_, err = io.Copy(io.Discard, reader)
			reader.Close()
		}
		completed <- err
	}()
	<-entered
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "../../scripts/test-blob-index.cjs", "wait-go", root)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	output := bufio.NewReader(stdout)
	signal, err := output.ReadString('\n')
	unblock()
	remaining, readErr := io.ReadAll(output)
	waitErr := command.Wait()
	if err != nil || signal != "waiting\n" || readErr != nil || waitErr != nil {
		t.Fatal(signal, string(remaining), err, readErr, waitErr, stderr.String())
	}
	if err := <-completed; err != nil {
		t.Fatal(err)
	}
	assertFillClean(t, cache)
}
