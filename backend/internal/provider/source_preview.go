package provider

import "context"

// SourcePreviews bounds author previews independently of full repository imports.
// Adapters must use the supplied identity and immutable revision.
type SourcePreviews interface {
	PreviewTree(context.Context, Access, int) ([]Entry, bool, error)
	PreviewFile(context.Context, Access, string, int64) ([]byte, int64, bool, error)
}
