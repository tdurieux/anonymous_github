package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type tarTestEntry struct {
	name, body, link string
	kind             byte
}

func tarTestBytes(t *testing.T, entries ...tarTestEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "pax_global_header", Typeflag: tar.TypeXGlobalHeader, PAXRecords: map[string]string{"comment": strings.Repeat("a", 40)}}); err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		kind := entry.kind
		if kind == 0 {
			kind = tar.TypeReg
		}
		size := int64(len(entry.body))
		if kind != tar.TypeReg {
			size = 0
		}
		if err := tw.WriteHeader(&tar.Header{Name: entry.name, Mode: 0600, Size: size, Typeflag: kind, Linkname: entry.link}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(entry.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestGitHubArchiveValidation(t *testing.T) {
	t.Run("regular files and symlink blob bytes", func(t *testing.T) {
		data := tarTestBytes(t, tarTestEntry{name: "root/", kind: tar.TypeDir}, tarTestEntry{name: "root/dir/a", body: "hello"}, tarTestEntry{name: "root/link", kind: tar.TypeSymlink, link: "../../target"})
		a, err := newGitHubArchive(t.Context(), io.NopCloser(bytes.NewReader(data)))
		if err != nil {
			t.Fatal(err)
		}
		defer a.Close()
		for _, want := range []struct{ name, body string }{{"dir/a", "hello"}, {"link", "../../target"}} {
			entry, body, err := a.Next()
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(body)
			if err != nil || entry.Path != want.name || string(data) != want.body || entry.Size != int64(len(data)) {
				t.Fatal(entry, string(data), err)
			}
		}
		if _, _, err = a.Next(); err != io.EOF {
			t.Fatal(err)
		}
	})
	for _, name := range []string{"root/../escape", "/root/file", "root/dir//file", "root\\file", "plain-file"} {
		t.Run(name, func(t *testing.T) {
			a, err := newGitHubArchive(t.Context(), io.NopCloser(bytes.NewReader(tarTestBytes(t, tarTestEntry{name: name, body: "x"}))))
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			if _, _, err = a.Next(); err == nil {
				t.Fatal("unsafe path accepted")
			}
		})
	}
	for _, kind := range []byte{tar.TypeLink, tar.TypeChar, tar.TypeFifo} {
		a, err := newGitHubArchive(t.Context(), io.NopCloser(bytes.NewReader(tarTestBytes(t, tarTestEntry{name: "root/file", kind: kind, link: "root/target"}))))
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err = a.Next(); err == nil {
			t.Fatal("unsafe type accepted", kind)
		}
		a.Close()
	}
	t.Run("checksum and truncation", func(t *testing.T) {
		good := tarTestBytes(t, tarTestEntry{name: "root/file", body: strings.Repeat("payload", 200)})
		corrupt := append([]byte(nil), good...)
		corrupt[len(corrupt)-8] ^= 1
		for _, data := range [][]byte{corrupt, good[:len(good)-4]} {
			a, err := newGitHubArchive(t.Context(), io.NopCloser(bytes.NewReader(data)))
			if err != nil {
				continue
			}
			for err == nil {
				var body io.Reader
				_, body, err = a.Next()
				if err == nil {
					_, err = io.Copy(io.Discard, body)
				}
			}
			a.Close()
			if err == io.EOF {
				t.Fatal("corrupted archive accepted")
			}
		}
	})
	t.Run("root change", func(t *testing.T) {
		a, err := newGitHubArchive(t.Context(), io.NopCloser(bytes.NewReader(tarTestBytes(t, tarTestEntry{name: "root/a"}, tarTestEntry{name: "other/b"}))))
		if err != nil {
			t.Fatal(err)
		}
		defer a.Close()
		if _, _, err = a.Next(); err != nil {
			t.Fatal(err)
		}
		if _, _, err = a.Next(); err == nil {
			t.Fatal("root changed")
		}
	})
}

func TestGitHubArchiveCancellationClosesBlockedRead(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	reader, writer := io.Pipe()
	defer writer.Close()
	done := make(chan error, 1)
	go func() { _, err := newGitHubArchive(ctx, reader); done <- err }()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled read succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked archive read survived cancellation")
	}
}

func TestGitHubArchiveRedirect(t *testing.T) {
	first, _ := http.NewRequest("GET", "https://api.github.com/repos/a/b/tarball/commit", nil)
	for _, target := range []string{"http://codeload.github.com/a", "https://evil.test/a", "https://codeload.github.com:444/a", "https://user@codeload.github.com/a"} {
		req, _ := http.NewRequest("GET", target, nil)
		if err := archiveRedirect(req, []*http.Request{first}); err == nil {
			t.Fatal("unsafe redirect", target)
		}
	}
	req, _ := http.NewRequest("GET", "https://codeload.github.com/a/b/legacy.tar.gz/commit?token=signed", nil)
	req.Header.Set("Authorization", "Bearer synthetic")
	if err := archiveRedirect(req, []*http.Request{first}); err != nil || req.Header.Get("Authorization") != "" {
		t.Fatal("credential forwarded", err)
	}
}
