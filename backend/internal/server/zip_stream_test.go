package server

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestZIPStreamsPayloadBeforeNextEntry(t *testing.T) {
	release := make(chan struct{})
	done := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		z := newStreamZIP(w)
		if err := z.add(r.Context(), "first.txt", strings.NewReader("first payload")); err != nil {
			done <- err
			return
		}
		select {
		case <-release:
		case <-r.Context().Done():
			done <- r.Context().Err()
			return
		}
		if err := z.add(r.Context(), "second.txt", strings.NewReader("second payload")); err != nil {
			done <- err
			return
		}
		done <- z.archive.Close()
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	// 30-byte local header + filename + at least one compressed payload byte.
	prefix := make([]byte, 30+len("first.txt")+1)
	if _, err = io.ReadFull(resp.Body, prefix); err != nil {
		t.Fatal("entry payload did not stream before next entry", err)
	}
	close(release)
	rest, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	data := append(prefix, rest...)
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if len(z.File) != 2 {
		t.Fatal("wrong entry count", len(z.File))
	}
	for i, expected := range []string{"first payload", "second payload"} {
		body, err := z.File[i].Open()
		if err != nil {
			t.Fatal(err)
		}
		actual, err := io.ReadAll(body)
		body.Close()
		if err != nil || string(actual) != expected {
			t.Fatal("ZIP content or CRC mismatch", string(actual), err)
		}
	}
}

type cancelZIPReader struct {
	cancel context.CancelFunc
	reads  int
}

func (r *cancelZIPReader) Read(p []byte) (int, error) {
	r.reads++
	r.cancel()
	copy(p, "payload")
	return len("payload"), nil
}
func TestZIPCopyStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	input := &cancelZIPReader{cancel: cancel}
	z := newStreamZIP(httptest.NewRecorder())
	if err := z.add(ctx, "file", input); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if input.reads != 1 {
		t.Fatal("continued consuming after cancellation", input.reads)
	}
}
