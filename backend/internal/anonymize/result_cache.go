package anonymize

import (
	"context"
	"io"
	"os"
	"sort"
	"sync"
	"time"
)

const resultCacheBudget int64 = 512 * 1024 * 1024
const resultCacheObjectLimit int64 = resultCacheBudget / 4
const resultCacheTTL = time.Hour

type resultEntry struct {
	path, owner string
	size        int64
	changed     bool
	created     time.Time
}

// Result caches are private to a process. The directory is created with mode
// 0700 and removed on shutdown; no credentials or source names enter filenames.
type resultCache struct {
	mu        sync.Mutex
	directory string
	entries   map[string]resultEntry
	flights   map[string]chan struct{}
	closed    bool
}

func (c *resultCache) prune(now time.Time) {
	keys := make([]string, 0, len(c.entries))
	for key := range c.entries {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return c.entries[keys[i]].created.After(c.entries[keys[j]].created) })
	var size int64
	for i, key := range keys {
		e := c.entries[key]
		size += e.size
		if i >= 128 || size > resultCacheBudget || now.Sub(e.created) > resultCacheTTL {
			os.Remove(e.path)
			delete(c.entries, key)
		}
	}
}
func (c *resultCache) begin(ctx context.Context, key string) (func(), error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		c.mu.Lock()
		if err := ctx.Err(); err != nil {
			c.mu.Unlock()
			return nil, err
		}
		if c.flights == nil {
			c.flights = map[string]chan struct{}{}
		}
		if ready, exists := c.flights[key]; exists {
			c.mu.Unlock()
			select {
			case <-ready:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		ready := make(chan struct{})
		c.flights[key] = ready
		c.mu.Unlock()
		return func() { c.mu.Lock(); delete(c.flights, key); close(ready); c.mu.Unlock() }, nil
	}
}
func (c *resultCache) copy(ctx context.Context, key, destination string) (*os.File, bool, bool) {
	c.mu.Lock()
	c.prune(time.Now())
	e, ok := c.entries[key]
	if !ok || c.closed {
		c.mu.Unlock()
		return nil, false, false
	}
	in, err := os.Open(e.path)
	c.mu.Unlock()
	if err != nil {
		c.discard(key, e.path)
		return nil, false, false
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != e.size {
		c.discard(key, e.path)
		return nil, false, false
	}
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return nil, false, false
	}
	n, err := io.Copy(out, contextReader{ctx, io.LimitReader(in, e.size+1)})
	if err == nil {
		err = ctx.Err()
	}
	if err == nil && n == e.size {
		_, err = out.Seek(0, io.SeekStart)
	} else if err == nil {
		err = io.ErrUnexpectedEOF
	}
	if err != nil {
		out.Close()
		os.Remove(destination)
		return nil, false, false
	}
	return out, e.changed, true
}
func (c *resultCache) put(ctx context.Context, key, owner string, out *os.File, changed bool) {
	info, err := out.Stat()
	if err != nil || info.Size() > resultCacheObjectLimit {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || ctx.Err() != nil {
		return
	}
	if c.directory == "" {
		c.directory, err = os.MkdirTemp("", "anonymous-go-results-")
		if err != nil {
			return
		}
		c.entries = map[string]resultEntry{}
	}
	if _, ok := c.entries[key]; ok {
		return
	}
	// Copy through a section reader: publishing must not advance the response.
	file, err := os.CreateTemp(c.directory, "result-")
	if err != nil {
		return
	}
	n, err := io.Copy(file, contextReader{ctx, io.NewSectionReader(out, 0, info.Size())})
	closeErr := file.Close()
	if err != nil || closeErr != nil || n != info.Size() || ctx.Err() != nil {
		os.Remove(file.Name())
		return
	}
	c.entries[key] = resultEntry{path: file.Name(), owner: owner, size: n, changed: changed, created: time.Now()}
	c.prune(time.Now())
}
func (c *resultCache) removeOwner(owner string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, e := range c.entries {
		if e.owner == owner {
			os.Remove(e.path)
			delete(c.entries, key)
		}
	}
}
func (c *resultCache) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	if c.directory != "" {
		os.RemoveAll(c.directory)
	}
	c.entries = nil
}
func (p *Pool) Close()                     { p.results.close() }
func (p *Pool) RemoveResults(owner string) { p.results.removeOwner(owner) }

func (p *Pool) PruneResults() {
	p.results.mu.Lock()
	defer p.results.mu.Unlock()
	p.results.prune(time.Now())
}

func (c *resultCache) discard(key, path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.entries[key]; ok && e.path == path {
		os.Remove(e.path)
		delete(c.entries, key)
	}
}

// Check cancellation between reads without spawning a goroutine that could leak
// if an arbitrary Reader blocks. Network readers retain their own context.
type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.reader.Read(p)
	if canceled := r.ctx.Err(); canceled != nil {
		return n, canceled
	}
	return n, err
}
