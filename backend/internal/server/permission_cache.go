package server

import (
	"crypto/sha256"
	"encoding/json"
	"sync"
	"time"
)

// Cache only successful remote checks. Callers must still check local account,
// credential and installation state on every request. Revision and token changes
// select a different entry; reads never extend the original freshness deadline.
type permissionCache struct {
	mu      sync.Mutex
	entries map[[32]byte]time.Time
}

func (s *Server) cachedPermission(parts []string, check func() error) error {
	ttl := s.Config.GitHubPermissionTTL
	if ttl <= 0 {
		return check()
	}
	if ttl > time.Hour {
		ttl = time.Hour
	}
	encoded, _ := json.Marshal(parts)
	key := sha256.Sum256(encoded)
	started := time.Now()
	s.permissions.mu.Lock()
	expiry := s.permissions.entries[key]
	s.permissions.mu.Unlock()
	if started.Before(expiry) {
		return nil
	}
	if err := check(); err != nil {
		return err
	}
	s.permissions.mu.Lock()
	defer s.permissions.mu.Unlock()
	if s.permissions.entries == nil || len(s.permissions.entries) >= 10000 {
		s.permissions.entries = make(map[[32]byte]time.Time)
	}
	s.permissions.entries[key] = started.Add(ttl)
	return nil
}
