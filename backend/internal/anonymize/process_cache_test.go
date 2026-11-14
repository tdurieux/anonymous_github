package anonymize

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestProcessCacheWorker(t *testing.T) {
	binary := os.Getenv("GO_TEST_SERVER_BINARY")
	if binary == "" {
		t.Skip("requires built worker binary")
	}
	pool := NewPool(binary, 2)
	defer pool.Close()
	request := ProcessRequest{Options: Options{Terms: []string{"Alice"}}, Context: Context{Mask: "XXXX"}, MaxOutput: MaxOutput, CacheScope: "revision-one", CacheOwner: "fixture"}
	stages, failures := map[string]int{}, map[string]int{}
	request.StageEvent = func(name string, elapsed time.Duration, err error) {
		if elapsed < 0 {
			t.Fatal("negative duration")
		}
		stages[name]++
		if err != nil {
			failures[name]++
		}
	}
	call := func(req ProcessRequest) (string, error) {
		f, _, cleanup, err := pool.Process(context.Background(), strings.NewReader("hello Alice"), req)
		if err != nil {
			return "", err
		}
		defer cleanup()
		data, err := io.ReadAll(f)
		return string(data), err
	}
	first, err := call(request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := call(request)
	if err != nil || second != first || pool.starts.Load() != 1 {
		t.Fatal("warm output", second, err, pool.Stats())
	}
	if stages["anonymize"] != 1 || stages["worker_wait"] < 2 {
		t.Fatal("cache hit ran worker or missing wait metrics", stages)
	}
	limited := request
	limited.MaxOutput = 2
	if _, err = call(limited); err == nil || err.Error() != "anonymized_output_too_large" {
		t.Fatal("cached output bypassed smaller limit", err)
	}
	if _, err = call(limited); err == nil || pool.starts.Load() != 3 {
		t.Fatal("failed output cached", err, pool.Stats())
	}
	if failures["anonymize"] != 2 {
		t.Fatal("worker errors missing", failures)
	}
	request.Context.Mask = "REDACTED"
	changed, err := call(request)
	if err != nil || changed == first || !strings.Contains(changed, "REDACTED") {
		t.Fatal("context collision", changed, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, _, err = pool.Process(ctx, strings.NewReader("hello Alice"), request)
	if err == nil {
		t.Fatal("canceled cache hit succeeded")
	}
	if pool.Stats()["running"] != 0 || pool.Stats()["waiting"] != int64(0) {
		t.Fatal("admission leaked", pool.Stats())
	}
}

type cancelingReader struct {
	cancel context.CancelFunc
	reads  int
}

func (r *cancelingReader) Read(p []byte) (int, error) {
	r.reads++
	r.cancel()
	copy(p, "bytes")
	return 5, nil
}
func TestProcessSpoolingCancellation(t *testing.T) {
	pool := NewPool("unused", 1)
	defer pool.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader := &cancelingReader{cancel: cancel}
	_, _, _, err := pool.Process(ctx, reader, ProcessRequest{})
	if !errors.Is(err, context.Canceled) || reader.reads != 1 || pool.starts.Load() != 0 || len(pool.slots) != 0 {
		t.Fatal(err, reader.reads, pool.Stats())
	}
}
func TestCacheCopyAndPublicationCancellation(t *testing.T) {
	c := &resultCache{}
	defer c.close()
	source, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	source.WriteString("output")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c.put(ctx, "canceled", "owner", source, true)
	if len(c.entries) != 0 {
		t.Fatal("canceled publication retained")
	}
	c.put(context.Background(), "valid", "owner", source, true)
	destination := t.TempDir() + "/output"
	if out, _, hit := c.copy(ctx, "valid", destination); hit {
		out.Close()
		t.Fatal("canceled copy succeeded")
	}
	if _, err = os.Stat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("partial output remains", err)
	}
	if _, err = c.begin(ctx, "unoccupied"); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled leader admitted", err)
	}
	if len(c.flights) != 0 {
		t.Fatal("canceled flight leaked")
	}
}

func TestProcessOutputReadersDoNotHoldWorkerAdmission(t *testing.T) {
	binary := os.Getenv("GO_TEST_SERVER_BINARY")
	if binary == "" {
		t.Skip("requires built worker binary")
	}
	pool := NewPool(binary, 1)
	defer pool.Close()
	request := ProcessRequest{Options: Options{Terms: []string{"Alice"}}, Context: Context{Mask: "XXXX"}, MaxOutput: MaxOutput, CacheScope: "slow-readers", CacheOwner: "fixture"}
	// Keep every output open, as a slow client would. Cover a cold result,
	// a cache hit and a different cold result with only one worker slot.
	for _, text := range []string{"first Alice", "first Alice", "second Alice"} {
		ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
		file, _, cleanup, err := pool.Process(ctx, strings.NewReader(text), request)
		cancel()
		if err != nil {
			t.Fatal("open output blocked subsequent worker", err)
		}
		defer cleanup()
		if len(pool.slots) != 0 {
			t.Fatal("completed worker retained slot")
		}
		if !pool.memory.TryAcquire(pool.budget) {
			t.Fatal("completed worker retained memory admission")
		}
		pool.memory.Release(pool.budget)
		actual, err := io.ReadAll(file)
		if err != nil || string(actual) != strings.ReplaceAll(text, "Alice", "XXXX-1") {
			t.Fatal(string(actual), err)
		}
	}
	if pool.starts.Load() != 2 {
		t.Fatal("cache hit unexpectedly started worker", pool.starts.Load())
	}
}
