package server

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDashboardCacheExpiryAndCapacity(t *testing.T) {
	now := time.Unix(1000, 0)
	cache := dashboardCache{now: func() time.Time { return now }}
	calls := 0
	calculate := func() error { calls++; return nil }
	ctx := context.Background()
	cache.run(ctx, "user", calculate)
	now = now.Add(4 * time.Minute)
	cache.run(ctx, "user", calculate)
	if calls != 1 {
		t.Fatal("cache miss before expiry")
	}
	now = now.Add(time.Minute)
	cache.run(ctx, "user", calculate)
	if calls != 2 {
		t.Fatal("entry did not expire")
	}
	cache.clear()
	for i := 0; i < 64; i++ {
		cache.run(ctx, fmt.Sprint(i), calculate)
	}
	before := calls
	cache.run(ctx, "0", calculate) // Reads do not change FIFO order.
	cache.run(ctx, "64", calculate)
	cache.run(ctx, "1", calculate)
	if calls != before+1 || len(cache.entries) != 64 {
		t.Fatal("capacity or FIFO mismatch")
	}
	cache.run(ctx, "0", calculate)
	if calls != before+2 {
		t.Fatal("oldest entry not evicted")
	}
}
func TestDashboardCacheConcurrency(t *testing.T) {
	var cache dashboardCache
	var calls atomic.Int64
	var wg sync.WaitGroup
	started, release := make(chan struct{}), make(chan struct{})
	calculate := func() error {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return nil
	}
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := cache.run(context.Background(), "user", calculate); err != nil {
				t.Error(err)
			}
		}()
	}
	<-started
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatal("duplicate work", calls.Load())
	}
}
func TestDashboardCacheRetryAndInvalidation(t *testing.T) {
	ctx := context.Background()
	var cache dashboardCache
	failure := errors.New("fixture failure")
	if err := cache.run(ctx, "user", func() error { return failure }); err != failure {
		t.Fatal(err)
	}
	if err := cache.run(ctx, "user", func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	cache.clear()
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		cache.run(ctx, "user", func() error { close(started); <-release; return failure })
		close(finished)
	}()
	<-started
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := cache.run(canceled, "user", func() error { t.Error("waiter calculated"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	cache.clear()
	if err := cache.run(ctx, "user", func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	close(release)
	<-finished
	if err := cache.run(ctx, "user", func() error { t.Error("old failure removed new entry"); return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestDashboardCacheTTLStartsOnCompletion(t *testing.T) {
	now := time.Unix(1000, 0)
	cache := dashboardCache{now: func() time.Time { return now }}
	ctx := context.Background()
	cache.run(ctx, "user", func() error { now = now.Add(10 * time.Minute); return nil })
	now = now.Add(4 * time.Minute)
	cache.run(ctx, "user", func() error { t.Fatal("TTL started before completion"); return nil })
}

func TestDashboardCachePanicDoesNotStrandEntry(t *testing.T) {
	var cache dashboardCache
	func() {
		defer func() {
			if recover() == nil {
				t.Error("panic was swallowed")
			}
		}()
		cache.run(context.Background(), "user", func() error { panic("fixture") })
	}()
	called := false
	if err := cache.run(context.Background(), "user", func() error { called = true; return nil }); err != nil || !called {
		t.Fatal("panic stranded cache entry", err)
	}
}
