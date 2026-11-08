package blobcache

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func TestStageTimingsDistinguishFillAndHit(t *testing.T) {
	counts := map[string]int{}
	cache, err := New(t.Context(), Options{Root: t.TempDir(), Budget: 65536, MaxObject: 4096, Stage: func(_ context.Context, name string, elapsed time.Duration, err error) {
		if err != nil || elapsed < 0 {
			t.Errorf("stage %s: %v %v", name, elapsed, err)
		}
		counts[name]++
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	calls := 0
	produce := func(context.Context) (io.ReadCloser, error) {
		calls++
		return io.NopCloser(strings.NewReader("fixture body")), nil
	}
	coldLookups := 0
	for i := 0; i < 2; i++ {
		body, err := cache.GetOrFill(t.Context(), "stage-fixture", produce, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			coldLookups = counts["cache_lookup"]
		}
		data, err := io.ReadAll(body)
		body.Close()
		if err != nil || string(data) != "fixture body" {
			t.Fatal(string(data), err)
		}
	}
	if calls != 1 || counts["cache_fill"] != 1 || coldLookups < 1 || counts["cache_lookup"] != coldLookups+1 {
		t.Fatal(calls, counts)
	}
}
