package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestLFSRedirectAuthorization(t *testing.T) {
	source := M{"repositoryName": "owner/repo", "commit": strings.Repeat("a", 40)}
	row := M{"name": "file.bin", "size": 123}
	for _, target := range []string{"https://media.githubusercontent.com/file", "https://attacker.example/file", "http://media.githubusercontent.com/file"} {
		calls := 0
		s := &Server{HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			calls++
			if calls == 1 {
				if r.Header.Get("Authorization") != "Bearer synthetic" {
					t.Fatal("missing initial grant")
				}
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{target}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
			}
			if r.Header.Get("Authorization") != "" {
				t.Fatal("grant leaked to content host")
			}
			return &http.Response{StatusCode: 200, ContentLength: 4, Body: io.NopCloser(strings.NewReader("data")), Request: r}, nil
		})}}
		body, e := s.inspectBlob(context.Background(), io.NopCloser(strings.NewReader("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 4\n")), M{"source": source}, row, "synthetic")
		allowed := strings.HasPrefix(target, "https://media.")
		if allowed {
			if e != nil {
				t.Fatal(e)
			}
			data, e := io.ReadAll(body)
			body.Close()
			if e != nil || string(data) != "data" {
				t.Fatalf("%q %v", data, e)
			}
		} else if e == nil || calls != 1 {
			t.Fatal("unsafe redirect accepted")
		}
	}
}
