package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"regexp"
	"strings"
)

var contentPrefixPattern = regexp.MustCompile(`^__content/[a-f0-9]{64}$`)
var retainedContentPattern = regexp.MustCompile(`^__content/(?:[a-f0-9]{64}|__retired)(?:/|$)`)

func contentGeneration(r M) string {
	generation := str(r["treeGeneration"])
	if generation == "" {
		generation = "legacy"
	}
	stamp := ""
	if d, valid := storedDate(r["anonymizeDate"]); valid {
		stamp = d.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return generation + ":" + stamp
}
func contentPrefix(r M) string {
	sum := sha256.Sum256([]byte(contentGeneration(r)))
	return "__content/" + hex.EncodeToString(sum[:])
}
func (s *Server) cleanupContent(ctx context.Context, r M) error {
	if s.pool != nil {
		s.pool.RemoveResults(str(r["repoId"]))
	}
	// ZIP originals are source data, not disposable upstream cache.
	if str(obj(r["source"])["type"]) == "Zip" {
		return nil
	}
	id := str(r["repoId"])
	active := contentPrefix(r)
	for _, prefix := range stringsOf(r["retiredContentPrefixes"]) {
		if !contentPrefixPattern.MatchString(prefix) || prefix == active {
			continue
		}
		marker := "__content/__retired/" + strings.TrimPrefix(prefix, "__content/") + ".txt"
		if e := s.content.Put(ctx, id, marker, strings.NewReader("retired"), 7, 7); e != nil {
			return e
		}
		if e := s.content.Remove(ctx, id, prefix); e != nil {
			return e
		}
		if _, e := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$pull": M{"retiredContentPrefixes": prefix}}); e != nil {
			return e
		}
	}
	if boolean(r["legacyContentCleanupPending"]) && str(r["status"]) == "ready" {
		rows, e := s.content.List(ctx, id)
		if e != nil && !errors.Is(e, fs.ErrNotExist) {
			return e
		}
		for _, entry := range rows {
			if !retainedContentPattern.MatchString(entry.Path) {
				if e = s.content.Remove(ctx, id, entry.Path); e != nil {
					return e
				}
			}
		}
		if _, e = s.Store.update(ctx, collection("repo"), M{"_id": r["_id"], "status": "ready", "source.type": M{"$ne": "Zip"}}, M{"$unset": M{"legacyContentCleanupPending": ""}}); e != nil {
			return e
		}
	}
	_, e := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"], "retiredContentPrefixes.0": M{"$exists": false}}, M{"$unset": M{"retiredContentPrefixes": ""}})
	return e
}
