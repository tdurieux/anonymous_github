package server

import (
	"compress/gzip"
	"compress/zlib"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

const webhookBodyLimit = 2 * 1024 * 1024

// Express verifies the decompressed bytes. Bound output independently of wire
// size so compression cannot bypass the webhook payload limit.
func readWebhookBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	var reader io.Reader = http.MaxBytesReader(w, r.Body, 8*1024*1024)
	encoding := strings.ToLower(r.Header.Get("Content-Encoding"))
	switch encoding {
	case "", "identity":
	case "gzip":
		decoded, err := gzip.NewReader(reader)
		if err != nil {
			return nil, err
		}
		defer decoded.Close()
		reader = decoded
	case "deflate":
		decoded, err := zlib.NewReader(reader)
		if err != nil {
			return nil, err
		}
		defer decoded.Close()
		reader = decoded
	case "br":
		reader = brotli.NewReader(reader)
	case "zstd":
		decoded, err := zstd.NewReader(reader, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(32*1024*1024), zstd.WithDecoderMaxWindow(32*1024*1024))
		if err != nil {
			return nil, err
		}
		defer decoded.Close()
		reader = decoded
	default:
		return nil, fail("unsupported_content_encoding", 415)
	}
	body, err := io.ReadAll(io.LimitReader(reader, webhookBodyLimit+1))
	if len(body) > webhookBodyLimit {
		return nil, &http.MaxBytesError{Limit: webhookBodyLimit}
	}
	// Node's Zstandard stream accepts an incomplete final frame and yields
	// the bytes decoded so far. Those bytes still require a valid signature.
	if encoding == "zstd" && errors.Is(err, io.ErrUnexpectedEOF) {
		err = nil
	}
	return body, err
}
