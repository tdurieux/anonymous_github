package server

import "io"

// Detect truncated responses even when upstream uses chunked transfer encoding.
// Returning a read error prevents the worker from publishing partial output.
type completeBody struct {
	io.ReadCloser
	expected, received int64
}

func checkedBody(body io.ReadCloser, expected int64) io.ReadCloser {
	return &completeBody{ReadCloser: body, expected: expected}
}
func (b *completeBody) Read(p []byte) (int, error) {
	n, e := b.ReadCloser.Read(p)
	b.received += int64(n)
	if e == io.EOF && b.received < b.expected {
		e = io.ErrUnexpectedEOF
	}
	return n, e
}
