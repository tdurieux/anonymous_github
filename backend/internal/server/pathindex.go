package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"path"
	"regexp"
	"strings"
	"time"
)

var errPathMetadataRepaired = errors.New("path metadata repaired")

func (s *Server) pathIndexKey(r M) string {
	fingerprint, _ := json.Marshal([]any{r["_id"], r["treeGeneration"], r["settingsSavedAt"], r["fileMetadataRevision"], r["contentCacheRevision"], obj(r["source"])["commit"], r["anonymizeDate"], obj(r["options"])["terms"], s.Config.Mask, "go-path-v5"})
	digest := sha256.Sum256(fingerprint)
	return "go:paths:" + hex.EncodeToString(digest[:])
}

// Website paths must reject collisions, unlike the legacy file endpoint's
// first-match behavior. Read readiness, row and collision markers atomically.
func (s *Server) indexedWebFile(ctx context.Context, r M, requested string) (M, error) {
	// Without custom replacements, every changed path contains the default mask.
	// A mask-free path can therefore only name an unchanged original. Confirm
	// that property, reject duplicate rows, and retain the full collision check
	// for malformed trees where a file also has descendants.
	plain := requested != "" && s.Config.Mask != "" && !strings.Contains(requested, s.Config.Mask)
	for _, term := range arr(obj(r["options"])["terms"]) {
		_, _, custom := anonymize.ParseTerm(str(term))
		plain = plain && !custom
	}
	if plain {
		cacheKey := s.pathIndexKey(r) + ":" + requested
		if row := s.cachedPlainWebFile(cacheKey); row != nil {
			if err := s.checkPathSnapshot(ctx, r); err != nil {
				return nil, err
			}
			return row, nil
		}
		engine, err := s.engine(r, "repo")
		if err != nil {
			return nil, err
		}
		transformed, err := engine.Path(ctx, requested)
		if err != nil {
			return nil, err
		}
		if transformed == requested {
			directory := path.Dir(requested)
			if directory == "." {
				directory = ""
			}
			rows, err := s.Store.list(ctx, "files", M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r), "path": directory, "name": path.Base(requested)}, 2, nil)
			if err != nil {
				return nil, err
			}
			if len(rows) > 1 {
				return nil, fail("ambiguous_anonymized_path", 409)
			}
			if len(rows) == 1 && rows[0]["size"] != nil {
				child, err := s.Store.one(ctx, "files", M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r), "path": M{"$regex": "^" + regexp.QuoteMeta(requested) + "(?:/|$)"}})
				if err != nil {
					return nil, err
				}
				if child == nil {
					if err := s.completeRecoveredMetadata(ctx, r, rows[0]); err != nil {
						return nil, err
					}
					if err := s.checkPathSnapshot(ctx, r); err != nil {
						return nil, err
					}
					s.cachePlainWebFile(s.pathIndexKey(r)+":"+requested, rows[0])
					return rows[0], nil
				}
			}
		}
	}

	for attempt := 0; attempt < 3; attempt++ {
		key := s.pathIndexKey(r)
		values, err := s.Store.Redis.HMGet(ctx, key, "ready", "p:"+requested, "collision:"+requested, "childcollision:"+requested).Result()
		if err != nil {
			return nil, err
		}
		if values[0] != "1" {
			if err := s.ensurePathIndex(ctx, r, key); err != nil && !errors.Is(err, errPathMetadataRepaired) {
				return nil, err
			}
			continue
		}
		if err := s.checkPathSnapshot(ctx, r); err != nil {
			return nil, err
		}
		if values[2] != nil || values[3] != nil {
			return nil, fail("ambiguous_anonymized_path", 409)
		}
		if values[1] == nil {
			return nil, nil
		}
		raw, ok := values[1].(string)
		var row M
		if !ok || json.Unmarshal([]byte(raw), &row) != nil {
			return nil, fail("path_index_invalid", 503)
		}
		return row, nil
	}
	return nil, fail("path_index_busy", 503)
}

func (s *Server) indexedFile(ctx context.Context, r M, requested string) (result M, resultErr error) {
	defer func() {
		if resultErr == nil {
			if err := s.checkPathSnapshot(ctx, r); err != nil {
				result, resultErr = nil, err
			}
		}
	}()
	directory := path.Dir(requested)
	if directory == "." {
		directory = ""
	}
	exact, err := s.Store.one(ctx, "files", M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r), "path": directory, "name": path.Base(requested)})
	if err != nil {
		return nil, err
	}
	if exact != nil {
		if err := s.completeRecoveredMetadata(ctx, r, exact); err != nil {
			return nil, err
		}
		return exact, nil
	}
	// Read readiness and the entry atomically. Retry once after eviction or
	// metadata repair, which changes the revision used by the cache key.
	for attempt := 0; attempt < 2; attempt++ {
		key := s.pathIndexKey(r)
		if err := s.ensurePathIndex(ctx, r, key); err != nil {
			if errors.Is(err, errPathMetadataRepaired) {
				continue
			}
			return nil, err
		}
		values, err := s.Store.Redis.HMGet(ctx, key, "ready", "p:"+requested).Result()
		if err != nil {
			return nil, err
		}
		if values[0] != "1" {
			continue
		}
		if values[1] == nil {
			if err := s.checkPathSnapshot(ctx, r); err != nil {
				return nil, err
			}
			return s.recoverTruncatedFile(ctx, r, requested)
		}
		raw, ok := values[1].(string)
		var row M
		if !ok || json.Unmarshal([]byte(raw), &row) != nil {
			return nil, fail("path_index_invalid", 503)
		}
		return row, nil
	}
	if err := s.checkPathSnapshot(ctx, r); err != nil {
		return nil, err
	}
	return nil, fail("path_index_busy", 503)
}

func (s *Server) ensurePathIndex(ctx context.Context, r M, key string) error {
	ready, e := s.Store.Redis.HExists(ctx, key, "ready").Result()
	if e != nil {
		return e
	}
	if !ready {
		token, e := security.RandomToken()
		if e != nil {
			return e
		}
		lock := key + ":lock"
		acquired, e := s.Store.Redis.SetNX(ctx, lock, token, time.Minute).Result()
		if e != nil {
			return e
		}
		if acquired {
			cleanup := func() {
				release, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				defer cancel()
				s.Store.Redis.Eval(release, `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end;return 0`, []string{lock}, token)
			}
			defer cleanup()
			if e = s.buildPathIndex(ctx, r, key, token); e != nil {
				return e
			}
		} else {
			wait, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			ticker := time.NewTicker(100 * time.Millisecond)
			defer ticker.Stop()
			for !ready {
				select {
				case <-wait.Done():
					return fail("path_index_busy", 503)
				case <-ticker.C:
					ready, e = s.Store.Redis.HExists(wait, key, "ready").Result()
					if e != nil {
						return e
					}
				}
			}
		}
	}
	return nil
}

func (s *Server) buildPathIndex(ctx context.Context, r M, key, token string) error {
	select {
	case s.pathBuilds <- struct{}{}:
		defer func() { <-s.pathBuilds }()
	case <-ctx.Done():
		return ctx.Err()
	}
	work := ctx
	if err := s.checkPathSnapshot(work, r); err != nil {
		return err
	}
	cursor, e := s.Store.DB.Collection("files").Find(work, M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r)}, options.Find().SetSort(bson.D{{Key: "path", Value: 1}, {Key: "name", Value: 1}}).SetBatchSize(256).SetProjection(M{"path": 1, "name": 1, "size": 1, "sha": 1, "upstream": 1, "submodule": 1, "metadataPending": 1, "recoverySnapshot": 1}))
	if e != nil {
		return e
	}
	defer cursor.Close(ctx)
	engine, e := s.engine(r, "repo")
	if e != nil {
		return e
	}
	temp := key + ":" + token
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = s.Store.Redis.Del(cleanup, temp).Err()
	}()
	// Bounded batches avoid retaining the repository's entire index in Go.
	// HSETNX preserves the first original path/name across batch boundaries.
	sequence := 0
	batchBytes := 0
	batch := []any{token, sequence}
	flush := func() error {
		if len(batch) == 2 {
			return nil
		}
		written, err := s.Store.Redis.Eval(work, `
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
if tonumber(ARGV[2]) > 0 and redis.call('HGET',KEYS[2],'batch') ~= ARGV[2] then return 0 end
for i=3,#ARGV,2 do
 local added = redis.call('HSETNX',KEYS[2],ARGV[i],ARGV[i+1])
 if added == 0 and string.sub(ARGV[i],1,2) == 'p:' then
  local path = string.sub(ARGV[i],3)
  local parent = string.match(path,'^(.*)/[^/]*$') or ''
  redis.call('HSET',KEYS[2],'collision:'..path,'1','childcollision:'..parent,'1')
 end
end
redis.call('HSET',KEYS[2],'batch',tonumber(ARGV[2])+1)
redis.call('PEXPIRE',KEYS[1],60000)
redis.call('PEXPIRE',KEYS[2],60000)
return 1`, []string{key + ":lock", temp}, batch...).Int()
		if err != nil {
			return err
		}
		if written != 1 {
			return fail("path_index_busy", 503)
		}
		sequence++
		batchBytes = 0
		batch = []any{token, sequence}
		return nil
	}
	repaired := false
	for cursor.Next(work) {
		var row M
		if e := cursor.Decode(&row); e != nil {
			return e
		}
		if row["metadataPending"] == true {
			if err := s.completeRecoveredMetadata(work, r, row); err != nil {
				return err
			}
			repaired = true
		}
		p, e := engine.Path(work, path.Join(str(row["path"]), str(row["name"])))
		if e != nil {
			return e
		}
		if _, e = security.RelativePath(p); e != nil {
			return fail("invalid_anonymized_path", 422)
		}
		field := "p:" + p
		data, err := json.Marshal(selectFields(row, "path", "name", "size", "sha", "upstream", "submodule"))
		if err != nil {
			return err
		}
		size := len(field) + len(data)
		if batchBytes > 0 && batchBytes+size > 1024*1024 {
			if err := flush(); err != nil {
				return err
			}
		}
		batch = append(batch, field, string(data))
		batchBytes += size
		if len(batch) >= 1002 || batchBytes >= 1024*1024 {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	if e := cursor.Err(); e != nil {
		return e
	}
	if repaired {
		// Never publish under the revision from before recovery. The caller
		// rebuilds using the updated repository snapshot and cache key.
		return errPathMetadataRepaired
	}
	batch = append(batch, "ready", "1")
	if e = flush(); e != nil {
		return e
	}
	if err := s.checkPathSnapshot(work, r); err != nil {
		return err
	}
	// A builder whose lease expired must not replace a newer builder's result.
	published, e := s.Store.Redis.Eval(work, `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('RENAME',KEYS[2],KEYS[3]); redis.call('EXPIRE',KEYS[3],600); return 1`, []string{key + ":lock", temp, key}, token).Int()
	if e != nil {
		return e
	}
	if published != 1 {
		return fail("path_index_busy", 503)
	}
	return s.checkPathSnapshot(work, r)
}

// checkPathSnapshot rejects rows read under retired settings or metadata.
// Cache-presence bookkeeping may change statusDate without changing file paths.
func pathSnapshotFilter(r M) M {
	filter := contentRevisionFilter(r)
	for _, field := range []string{"fileMetadataRevision"} {
		if value, ok := r[field]; ok {
			filter[field] = value
		} else {
			filter[field] = M{"$exists": false}
		}
	}
	if value, ok := obj(r["source"])["commit"]; ok {
		filter["source.commit"] = value
	} else {
		filter["source.commit"] = M{"$exists": false}
	}
	if value, ok := obj(r["options"])["terms"]; ok {
		filter["options.terms"] = value
	} else {
		filter["options.terms"] = M{"$exists": false}
	}
	return filter
}

func (s *Server) checkPathSnapshot(ctx context.Context, r M) error {
	return s.checkPathSnapshotStatus(ctx, r, false)
}
func (s *Server) checkPathSnapshotStatus(ctx context.Context, r M, allowArchived bool) error {
	current, err := s.Store.one(ctx, collection("repo"), pathSnapshotFilter(r))
	if err != nil {
		return err
	}
	if current == nil {
		return fail("repository_changed", 409)
	}
	switch str(current["status"]) {
	case "expired", "expiring", "removed", "removing":
		return fail("repository_changed", 409)
	case "archived":
		if !allowArchived {
			return fail("repository_changed", 409)
		}
	}
	return nil
}
