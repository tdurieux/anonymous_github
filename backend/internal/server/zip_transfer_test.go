package server

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestZIPRequestDeadline(t *testing.T) {
	for _, test := range []struct {
		method, path string
		want         time.Duration
	}{
		{"GET", "/api/repo/repository/zip", 30 * time.Minute},
		{"HEAD", "/api/repo/repository/zip/", 30 * time.Minute},
		{"POST", "/api/repo/repository/zip", 2 * time.Minute},
		{"GET", "/api/repo/repository/file/a.zip", 2 * time.Minute},
		{"GET", "/other/zip", 2 * time.Minute},
	} {
		req := httptest.NewRequest(test.method, test.path, nil)
		if got := requestTimeout(req); got != test.want {
			t.Fatal(test, got)
		}
	}
}

func TestZIPRenewsExpiredServerWriteDeadline(t *testing.T) {
	release := make(chan struct{})
	done := make(chan error, 1)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		z := newStreamZIP(w)
		if err := z.add(r.Context(), "first", strings.NewReader("first entry")); err != nil {
			done <- err
			return
		}
		select {
		case <-release:
		case <-r.Context().Done():
			done <- r.Context().Err()
			return
		}
		if err := z.add(r.Context(), "second", strings.NewReader("second entry")); err != nil {
			done <- err
			return
		}
		done <- z.archive.Close()
	}))
	srv.Config.WriteTimeout = 30 * time.Millisecond
	srv.Start()
	defer srv.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL, nil)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	first := make([]byte, 36)
	if _, err := io.ReadFull(resp.Body, first); err != nil {
		t.Fatal(err)
	}
	time.Sleep(80 * time.Millisecond) // longer than the ordinary server deadline
	close(release)
	rest, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	data := append(first, rest...)
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != 2 {
		t.Fatal("incomplete archive")
	}
	for _, entry := range archive.File {
		body, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		_, err = io.Copy(io.Discard, body)
		body.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
}

type zipZeroReader struct{}

func (zipZeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func TestZIPStalledSocketStillTimesOut(t *testing.T) {
	done := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		output := &zipResponseWriter{ResponseWriter: w, idle: 30 * time.Millisecond}
		_, err := io.CopyN(output, zipZeroReader{}, 64<<20)
		done <- err
	}))
	defer srv.Close()
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, "GET / HTTP/1.1\r\nHost: test\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		var timeout net.Error
		if !errors.As(err, &timeout) || !timeout.Timeout() {
			t.Fatal("stalled socket did not time out", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stalled socket kept transfer alive")
	}
}

func TestZIPFailureClassification(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if got := zipFailureReason(ctx, io.ErrClosedPipe); got != "client_cancelled" {
		t.Fatal(got)
	}
	if got := zipFailureReason(t.Context(), io.ErrUnexpectedEOF); got != "truncated_source" {
		t.Fatal(got)
	}
	if got := zipFailureReason(t.Context(), errors.New("https://upstream.test/?secret=private")); got != "archive_stream_failed" {
		t.Fatal("unsafe error detail", got)
	}
}
