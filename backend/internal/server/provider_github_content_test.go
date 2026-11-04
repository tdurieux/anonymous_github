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

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

func TestGitHubContentVerificationContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/content-verification.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name, Pointer, Revision, Expected, Error string
		Proof                                    provider.ContentProof
		Fetched                                  int
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			fetched := 0
			result, err := verifyGitHubContent(t.Context(), f.Revision, f.Proof, func(context.Context) (io.ReadCloser, error) {
				fetched++
				return io.NopCloser(strings.NewReader(f.Pointer)), nil
			})
			if result != f.Expected || (err == nil) != (f.Error == "") || (err != nil && err.Error() != f.Error) || fetched != f.Fetched {
				t.Fatal(result, err, f.Expected, f.Error, fetched, f.Fetched)
			}
		})
	}
}

func TestGitHubContentVerificationCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	input, output := io.Pipe()
	defer output.Close()
	entered := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := verifyGitHubContent(ctx, strings.Repeat("a", 40), provider.ContentProof{}, func(context.Context) (io.ReadCloser, error) { close(entered); return input, nil })
		done <- err
	}()
	<-entered
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked pointer not canceled")
	}
}

func TestGitHubPointerRequest(t *testing.T) {
	for _, status := range []int{200, 302, 403, 404, 422, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			s := &Server{HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.String() != "https://api.github.com/repos/owner/repo/git/blobs/"+strings.Repeat("a", 40) || r.Header.Get("Authorization") != "Bearer synthetic" || r.Header.Get("Accept") != "application/vnd.github.raw+json" {
					t.Fatal(r.URL, r.Header)
				}
				return &http.Response{StatusCode: status, Header: http.Header{"Location": []string{"https://attacker.example"}}, Body: io.NopCloser(strings.NewReader("pointer")), ContentLength: 7, Request: r}, nil
			})}}
			body, err := s.githubPointer(t.Context(), "owner/repo", strings.Repeat("a", 40), "synthetic")
			if status == 200 {
				if err != nil {
					t.Fatal(err)
				}
				body.Close()
			} else if err == nil {
				body.Close()
				t.Fatal("accepted failure")
			}
			if calls != 1 {
				t.Fatal("pointer request followed redirect or fallback", calls)
			}
		})
	}
}

func TestGitHubContentVerificationBoundsAndErrors(t *testing.T) {
	for _, test := range []struct {
		name, revision string
		canceled       bool
	}{
		{name: "malformed revision", revision: "../main"},
		{name: "uppercase revision", revision: strings.Repeat("A", 40)},
		{name: "canceled", revision: strings.Repeat("a", 40), canceled: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if test.canceled {
				cancel()
			}
			_, err := verifyGitHubContent(ctx, test.revision, provider.ContentProof{}, func(context.Context) (io.ReadCloser, error) { t.Fatal("unexpected pointer download"); return nil, nil })
			if err == nil {
				t.Fatal("accepted invalid verification")
			}
		})
	}
	t.Run("bounded read", func(t *testing.T) {
		body := &trackedPointer{Reader: strings.NewReader(strings.Repeat("x", 4096))}
		_, err := verifyGitHubContent(t.Context(), strings.Repeat("a", 40), provider.ContentProof{}, func(ctx context.Context) (io.ReadCloser, error) {
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > 30*time.Second {
				t.Fatal("missing pointer deadline")
			}
			return body, nil
		})
		if err == nil || err.Error() != "invalid_lfs_pointer" || body.bytes != 1025 || body.closes != 1 {
			t.Fatal(err, body.bytes, body.closes)
		}
	})
	t.Run("upstream error", func(t *testing.T) {
		sentinel := errors.New("upstream unavailable")
		_, err := verifyGitHubContent(t.Context(), strings.Repeat("a", 40), provider.ContentProof{}, func(context.Context) (io.ReadCloser, error) { return nil, sentinel })
		if !errors.Is(err, sentinel) {
			t.Fatal(err)
		}
	})
	t.Run("adapter ordinary content", func(t *testing.T) {
		adapter := &githubProvider{} // The hash fast path requires no additional network request.
		sha := strings.Repeat("a", 40)
		result, err := adapter.VerifyContent(t.Context(), provider.Access{}, provider.Entry{Revision: sha}, provider.ContentProof{GitSHA: sha})
		if err != nil || result != "git-"+sha {
			t.Fatal(result, err)
		}
	})
}

type trackedPointer struct {
	io.Reader
	bytes, closes int
}

func (p *trackedPointer) Read(b []byte) (int, error) {
	n, err := p.Reader.Read(b)
	p.bytes += n
	return n, err
}
func (p *trackedPointer) Close() error { p.closes++; return nil }

func TestGitHubPointerRejectsOversizeAndInvalidIdentity(t *testing.T) {
	body := &trackedPointer{Reader: strings.NewReader("unused")}
	calls := 0
	s := &Server{HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Body: body, ContentLength: 1025, Header: make(http.Header), Request: r}, nil
	})}}
	for _, name := range []string{"../repo", "owner/repo?evil", "owner/repo"} {
		reader, err := s.githubPointer(t.Context(), name, strings.Repeat("a", 40), "synthetic")
		if err == nil || reader != nil {
			t.Fatal("accepted invalid pointer response", reader, err)
		}
	}
	if calls != 1 || body.bytes != 0 || body.closes != 1 {
		t.Fatal(calls, body.bytes, body.closes)
	}
}
