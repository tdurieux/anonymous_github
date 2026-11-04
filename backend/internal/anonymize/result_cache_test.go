package anonymize

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestResultCache(t *testing.T) {
	c := &resultCache{}
	defer c.close()
	source, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	source.WriteString("masked content")
	c.put(context.Background(), "key", "owner", source, true)
	read := func(key string) bool {
		f, changed, hit := c.copy(context.Background(), key, filepath.Join(t.TempDir(), "output"))
		if !hit {
			return false
		}
		defer f.Close()
		raw, err := io.ReadAll(f)
		if err != nil || string(raw) != "masked content" || !changed {
			t.Fatal(string(raw), changed, err)
		}
		return true
	}
	if !read("key") {
		t.Fatal("cache miss")
	}
	c.removeOwner("other")
	if !read("key") {
		t.Fatal("wrong owner invalidated")
	}
	c.removeOwner("owner")
	if read("key") {
		t.Fatal("removed cache reused")
	}
	c.put(context.Background(), "key", "owner", source, true)
	entry := c.entries["key"]
	entry.created = time.Now().Add(-2 * time.Hour)
	c.entries["key"] = entry
	if read("key") {
		t.Fatal("expired cache reused")
	}
	c.put(context.Background(), "key", "owner", source, true)
	if err := os.Truncate(c.entries["key"].path, 1); err != nil {
		t.Fatal(err)
	}
	if read("key") {
		t.Fatal("truncated cache reused")
	}
	c.put(context.Background(), "key", "owner", source, true)
	if !read("key") {
		t.Fatal("corrupted cache was not repaired")
	}
	c.close()
	c.put(context.Background(), "after-close", "owner", source, true)
	if len(c.entries) != 0 {
		t.Fatal("published after shutdown")
	}
}
func TestResultCacheCoordination(t *testing.T) {
	c := &resultCache{}
	defer c.close()
	release, err := c.begin(context.Background(), "key")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.begin(ctx, "key"); err == nil {
		t.Fatal("canceled waiter admitted")
	}
	release()
	next, err := c.begin(context.Background(), "key")
	if err != nil {
		t.Fatal(err)
	}
	next()
	if len(c.flights) != 0 {
		t.Fatal("leaked flight")
	}
}
func TestResultCacheBudgets(t *testing.T) {
	c := &resultCache{entries: map[string]resultEntry{}}
	now := time.Now()
	for i := 0; i < 129; i++ {
		c.entries[string(rune(i))] = resultEntry{created: now.Add(time.Duration(i) * time.Second), size: 1}
	}
	c.prune(now)
	if len(c.entries) != 128 {
		t.Fatal("entry limit", len(c.entries))
	}
	c.entries = map[string]resultEntry{"old": {created: now.Add(-time.Minute), size: resultCacheBudget}, "new": {created: now, size: 1}}
	c.prune(now)
	if len(c.entries) != 1 || c.entries["new"].size != 1 {
		t.Fatal("byte limit", c.entries)
	}
}
