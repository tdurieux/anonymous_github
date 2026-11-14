package provider

import (
	"context"
	"errors"
	"io"
)

// Archives optionally supplies a sequential, immutable repository snapshot.
// Entries contain repository-relative paths, with no archive root prefix.
// Bodies are valid until Next is called; callers must consume them first.
// Implementations must honor cancellation, validate archive structure and
// checksums, and never follow filesystem links. Close releases the upstream.
type Archives interface {
	OpenArchive(context.Context, Access) (Archive, error)
}

type Archive interface {
	Next() (Entry, io.Reader, error)
	Close() error
}

// ArchiveContentVerifier can request the normal file path when an archive
// representation differs from a blob (for example export-subst or LFS).
// Returning ErrArchiveEntryFallback never permits unverified bytes through.
type ArchiveContentVerifier interface {
	VerifyArchiveContent(context.Context, Access, Entry, ContentProof, []byte) error
}

var ErrArchiveEntryFallback = errors.New("archive_entry_requires_file_download")
