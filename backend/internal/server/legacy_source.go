package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

// Only providers with a content verifier may promote these files. Their
// location or size alone does not establish that they contain the right bytes.
func legacySourcePaths(r M, a provider.Access, entry provider.Entry) []string {
	var serialized bytes.Buffer
	encoder := json.NewEncoder(&serialized)
	encoder.SetEscapeHTML(false)
	// JSON.stringify serializes absent array members as null.
	_ = encoder.Encode([]any{a.Ref.Commit, entry.Revision, contentGeneration(r), r["contentCacheRevision"]})
	digest := sha256.Sum256(jsonSeparators(bytes.TrimSuffix(serialized.Bytes(), []byte("\n"))))
	node := contentPrefix(r) + "/" + hex.EncodeToString(digest[:]) + "/" + entry.Path
	return []string{rawCachePath(r, a, entry), node, entry.Path}
}
