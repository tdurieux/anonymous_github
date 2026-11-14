package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestTypeScriptGitHubResponses(t *testing.T) {
	raw, err := os.ReadFile("testdata/github-responses.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string
		Status   int
		Headers  map[string]string
		Expected *struct {
			Code   string
			Status int
		}
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			s := &Server{HTTP: &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
				if deadline, ok := req.Context().Deadline(); !ok || time.Until(deadline) > 20*time.Second {
					t.Fatal("missing API deadline")
				}
				header := http.Header{}
				for key, value := range c.Headers {
					header.Set(key, value)
				}
				return &http.Response{StatusCode: c.Status, Header: header, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
			})}}
			value, err := s.github(context.Background(), "GET", "/user", "synthetic", nil)
			if c.Expected == nil {
				if err != nil {
					t.Fatal(err)
				}
				if c.Status == 204 && value != nil {
					t.Fatal(value)
				}
				return
			}
			var api *APIError
			if !errors.As(err, &api) || api.Code != c.Expected.Code || api.Status != c.Expected.Status {
				t.Fatalf("got %v; expected %+v", err, c.Expected)
			}
		})
	}
}

// Upstream JSON failures deliberately have stable errors in Go, rather than
// leaking the JSON parser exception thrown by the TypeScript client.
func TestGitHubResponseFraming(t *testing.T) {
	for _, c := range []struct {
		name, body, code string
	}{
		{"empty", "", "github_invalid_response"},
		{"truncated", `{"token":"synthetic-secret"`, "github_invalid_response"},
		{"trailing text", `{"ok":true} synthetic-secret`, "github_invalid_response"},
		{"multiple values", `{} {}`, "github_invalid_response"},
		{"oversized", strings.Repeat(" ", 32*1024*1024+1), "github_response_too_large"},
	} {
		t.Run(c.name, func(t *testing.T) {
			body := &trackedGitHubBody{Reader: strings.NewReader(c.body)}
			s := &Server{HTTP: &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: body}, nil
			})}}
			_, err := s.github(context.Background(), "GET", "/user", "synthetic", nil)
			var api *APIError
			if !errors.As(err, &api) || api.Code != c.code || api.Status != 502 {
				t.Fatalf("unexpected error: %v", err)
			}
			if !body.closed {
				t.Fatal("response body not closed")
			}
		})
	}
}

type trackedGitHubBody struct {
	*strings.Reader
	closed bool
}

func (b *trackedGitHubBody) Close() error {
	b.closed = true
	return nil
}
