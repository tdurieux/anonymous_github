package server

import (
	"encoding/json"
	"sync"
	"time"
)

type webFileCacheEntry struct {
	data    []byte
	expires time.Time
}
type webFileCache struct {
	mu      sync.Mutex
	entries map[string]webFileCacheEntry
}

// Cache only a proven unique, unchanged file path. The key includes repository
// path/settings revisions; callers still validate the live snapshot and access.
func (s *Server) cachedPlainWebFile(key string) M {
	s.webFiles.mu.Lock()
	entry := s.webFiles.entries[key]
	s.webFiles.mu.Unlock()
	if !time.Now().Before(entry.expires) {
		return nil
	}
	var row M
	if json.Unmarshal(entry.data, &row) != nil {
		return nil
	}
	return row
}
func (s *Server) cachePlainWebFile(key string, row M) {
	data, err := json.Marshal(selectFields(row, "path", "name", "size", "sha", "upstream", "submodule"))
	if err != nil {
		return
	}
	s.webFiles.mu.Lock()
	defer s.webFiles.mu.Unlock()
	if s.webFiles.entries == nil || len(s.webFiles.entries) >= 1000 {
		s.webFiles.entries = map[string]webFileCacheEntry{}
	}
	s.webFiles.entries[key] = webFileCacheEntry{data, time.Now().Add(10 * time.Minute)}
}
