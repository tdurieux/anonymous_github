package server

import (
	"errors"
	"io"
	"strings"
	"testing"
)

func TestTruncatedBody(t *testing.T) {
	for _, tc := range []struct {
		body      string
		expected  int64
		truncated bool
	}{{"abc", 4, true}, {"abc", 3, false}, {"abcd", 3, false}} {
		_, e := io.ReadAll(checkedBody(io.NopCloser(strings.NewReader(tc.body)), tc.expected))
		if errors.Is(e, io.ErrUnexpectedEOF) != tc.truncated {
			t.Fatalf("expected=%d got=%v", tc.expected, e)
		}
	}
}
