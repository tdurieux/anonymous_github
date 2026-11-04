package server

import (
	"archive/zip"
	"compress/flate"
	"context"
	"errors"
	"io"
	"net/http"
	"time"
)

// streamZIP keeps compression and socket buffering bounded without flushing
// every write. Flush only after authorized entry bytes have been copied.
type streamZIP struct {
	archive    *zip.Writer
	compressor *flate.Writer
	response   http.ResponseWriter
	lastFlush  time.Time
	copyBuffer []byte
}

func newStreamZIP(w http.ResponseWriter) *streamZIP {
	output := &zipResponseWriter{ResponseWriter: w, idle: time.Minute}
	s := &streamZIP{archive: zip.NewWriter(output), response: output, copyBuffer: make([]byte, 32<<10)}
	s.archive.RegisterCompressor(zip.Deflate, func(dst io.Writer) (io.WriteCloser, error) {
		if s.compressor == nil {
			var err error
			s.compressor, err = flate.NewWriter(dst, 5) // archive/zip's default level
			if err != nil {
				return nil, err
			}
		} else {
			s.compressor.Reset(dst)
		}
		return s.compressor, nil
	})
	return s
}

func (s *streamZIP) add(ctx context.Context, name string, input io.Reader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	entry, err := s.archive.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate})
	if err != nil {
		return err
	}
	if _, err = io.CopyBuffer(entry, &zipContextReader{ctx: ctx, reader: input}, s.copyBuffer); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// A sync flush makes compressed payload available without ending the entry.
	// The ZIP writer still owns CRCs, entry finalization and the central directory.
	if s.lastFlush.IsZero() || time.Since(s.lastFlush) >= 250*time.Millisecond {
		if err = s.compressor.Flush(); err != nil {
			return err
		}
		if err = s.archive.Flush(); err != nil {
			return err
		}
		if err = http.NewResponseController(s.response).Flush(); err != nil {
			return err
		}
		s.lastFlush = time.Now()
	}
	return nil
}

type zipContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *zipContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

// Set a fresh write deadline for each actual write, rather than limiting the
// whole download to http.Server.WriteTimeout. A stalled socket still expires.
type zipResponseWriter struct {
	http.ResponseWriter
	idle time.Duration
}

func (w *zipResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *zipResponseWriter) deadline() error {
	err := http.NewResponseController(w.ResponseWriter).SetWriteDeadline(time.Now().Add(w.idle))
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}
func (w *zipResponseWriter) Write(p []byte) (int, error) {
	if err := w.deadline(); err != nil {
		return 0, err
	}
	return w.ResponseWriter.Write(p)
}
func (w *zipResponseWriter) FlushError() error {
	if err := w.deadline(); err != nil {
		return err
	}
	return http.NewResponseController(w.ResponseWriter).Flush()
}
