package quotagate

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestLocalGateBoundsAndCancellation(t *testing.T) {
	ctx := context.Background()
	g := New(nil)
	reset := time.Now().Add(time.Hour).Truncate(time.Millisecond)
	for i := 0; i < maxLocal+100; i++ {
		if err := g.Extend(ctx, "forge", fmt.Sprint(i), reset); err != nil {
			t.Fatal(err)
		}
	}
	if len(g.local) > maxLocal {
		t.Fatal("unbounded local cache")
	}
	if err := g.Extend(ctx, "forge", "secret", reset); err != nil {
		t.Fatal(err)
	}
	if err := g.Extend(ctx, "forge", "secret", reset.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	got, err := g.Current(ctx, "forge", "secret")
	if err != nil || !got.Equal(reset) {
		t.Fatal(got, err)
	}
	if got, _ := g.Current(ctx, "other-forge", "secret"); !got.IsZero() {
		t.Fatal("provider scopes mixed")
	}
	for k := range g.local {
		if strings.Contains(k, "secret") || strings.Contains(k, "forge") {
			t.Fatal("scope exposed in key")
		}
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := g.Current(canceled, "forge", "secret"); err != context.Canceled {
		t.Fatal(err)
	}
	if err := g.Extend(canceled, "forge", "secret", reset.Add(time.Hour)); err != context.Canceled {
		t.Fatal(err)
	}
	got, _ = g.Current(ctx, "forge", "secret")
	if !got.Equal(reset) {
		t.Fatal("canceled extension changed gate")
	}
}

func TestSharedGateIntegration(t *testing.T) {
	address := os.Getenv("GO_TEST_REDIS_ADDR")
	if address == "" {
		t.Skip("requires disposable Redis")
	}
	if !strings.HasPrefix(address, "127.0.0.1:") {
		t.Fatal("requires local disposable Redis")
	}
	ctx := context.Background()
	client := redis.NewClient(&redis.Options{Addr: address, MaxRetries: -1})
	defer client.Close()
	scope := fmt.Sprintf("synthetic-secret-%d", time.Now().UnixNano())
	providers := []string{"forge-one", "forge-two"}
	defer func() {
		for _, p := range providers {
			client.Del(ctx, key(p, scope))
		}
	}()
	a, b := New(client), New(client)
	now := time.Now().Truncate(time.Millisecond)
	var wg sync.WaitGroup
	for i := 1; i <= 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			g := a
			if i%2 == 0 {
				g = b
			}
			if err := g.Extend(ctx, providers[0], scope, now.Add(time.Duration(i)*time.Minute)); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	want := now.Add(40 * time.Minute)
	fresh := New(client)
	got, err := fresh.Current(ctx, providers[0], scope)
	if err != nil || !got.Equal(want) {
		t.Fatal(got, err)
	}
	if got, _ := b.Current(ctx, providers[1], scope); !got.IsZero() {
		t.Fatal("providers share gate")
	}
	if got, _ := b.Current(ctx, providers[0], scope+"other"); !got.IsZero() {
		t.Fatal("credentials share gate")
	}
	ttl, err := client.PTTL(ctx, key(providers[0], scope)).Result()
	if err != nil || ttl <= 0 || ttl > 40*time.Minute+10*time.Second {
		t.Fatal(ttl, err)
	}
	// A fresh scope expires in both the shared and local cache.
	if err := b.Extend(ctx, providers[1], scope, time.Now().Add(30*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if got, err := b.Current(ctx, providers[1], scope); err != nil || !got.IsZero() {
		t.Fatal(got, err)
	}
	// Corrupt shared values neither create a permanent gate nor prevent repair.
	if err := client.Set(ctx, key(providers[1], scope), "9223372036854775807", time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	if got, _ := b.Current(ctx, providers[1], scope); !got.IsZero() {
		t.Fatal("invalid timestamp accepted")
	}
	if err := b.Extend(ctx, providers[1], scope, want); err != nil {
		t.Fatal(err)
	}
	if got, _ := New(client).Current(ctx, providers[1], scope); !got.Equal(want) {
		t.Fatal("corrupt gate not repaired", got)
	}
	// A local observation survives an unavailable Redis connection.
	dead := redis.NewClient(&redis.Options{Addr: address, MaxRetries: -1})
	fallback := New(dead)
	if got, _ := fallback.Current(ctx, providers[0], scope); !got.Equal(want) {
		t.Fatal(got)
	}
	dead.Close()
	if got, err := fallback.Current(ctx, providers[0], scope); err != nil || !got.Equal(want) {
		t.Fatal("lost fallback", got, err)
	}
	if got, err := fallback.Current(ctx, providers[0], scope+"unknown"); err != nil || !got.IsZero() {
		t.Fatal("outage did not fail open", got, err)
	}
}
