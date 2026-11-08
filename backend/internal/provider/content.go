package provider

import "context"

// ContentProof describes bytes hashed by the cache, not metadata supplied by a
// client or upstream service. GitSHA includes the Git blob header.
type ContentProof struct {
	GitSHA, SHA256 string
	Size           int64
}

// ContentVerifier optionally binds downloaded bytes to a provider's immutable
// entry revision. Return "git-" plus proof.GitSHA or "sha256-" plus proof.SHA256.
// Providers without this capability use a computed SHA-256 content identity.
// This capability does not authorize access; callers must authorize before
// both cache lookups and downloads. Implementations must honor cancellation.
type ContentVerifier interface {
	VerifyContent(context.Context, Access, Entry, ContentProof) (string, error)
}

// ContentIdentity optionally supplies a globally reusable cache key. Implement
// only alongside ContentVerifier when the revision proves content identity.
// Empty means use the server's provider/repository/path/revision namespace.
type ContentIdentity interface {
	ContentVerifier
	ContentCacheKey(Access, Entry) string
}
