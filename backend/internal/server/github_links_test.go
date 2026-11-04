package server

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

func TestGitHubLinkPagination(t *testing.T) {
	for _, firstBody := range []string{`[{"id":1}]`, `[]`, "[" + strings.Repeat(`{"id":1},`, 99) + `{"id":1}]`} {
		t.Run("first-page-bytes-"+strconv.Itoa(len(firstBody)), func(t *testing.T) {
			calls, visited := 0, 0
			s := &Server{HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				body := firstBody
				headers := http.Header{}
				if r.URL.Host != "api.github.com" || r.Header.Get("Authorization") != "Bearer synthetic" {
					t.Fatal("credential destination changed", r.URL)
				}
				if calls == 1 {
					headers["Link"] = []string{`<https://api.github.com/user/repos?page=1>; rel="prev"`, `<https://api.github.com/user/repos?after=opaque%2Bcursor&per_page=7>; rel="next"`}
				} else {
					if calls != 2 || r.URL.RawQuery != "after=opaque%2Bcursor&per_page=7" {
						t.Fatal("cursor modified", r.URL)
					}
					body = `[{"id":2}]`
					headers.Set("Link", `<https://api.github.com/user/repos?page=1>; rel="prev"`)
				}
				return &http.Response{StatusCode: 200, Header: headers, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}}
			err := s.githubPages(context.Background(), "/user/repos", "synthetic", "", func(M) bool { visited++; return false })
			want := 2
			if firstBody == "[]" {
				want = 1
			} else if len(firstBody) > 100 {
				want = 101
			}
			if err != nil || calls != 2 || visited != want {
				t.Fatal(calls, visited, err)
			}
		})
	}
	t.Run("full final page does not request another", func(t *testing.T) {
		calls := 0
		s := &Server{HTTP: &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("[" + strings.Repeat(`{"id":1},`, 99) + `{"id":1}]`))}, nil
		})}}
		if err := s.githubPages(context.Background(), "/user/repos", "synthetic", "", func(M) bool { return false }); err != nil || calls != 1 {
			t.Fatal(calls, err)
		}
	})
	for _, target := range []string{"https://evil.test/repos", "http://api.github.com/repos", "https://api.github.com:443/repos", "https://user@api.github.com/repos", "https://api.github.com/repos#fragment", "//evil.test/repos", "https://api.github.com//evil.test/repos", "https://api.github.com/\\evil.test/repos"} {
		t.Run(target, func(t *testing.T) {
			calls := 0
			s := &Server{HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				if calls > 1 {
					t.Fatal("untrusted next link was requested", r.URL)
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Link": []string{"<" + target + `>; rel="next"`}}, Body: io.NopCloser(strings.NewReader("[]"))}, nil
			})}}
			if err := s.githubPages(context.Background(), "/user/repos", "synthetic", "", func(M) bool { return false }); err == nil || calls != 1 {
				t.Fatal(calls, err)
			}
		})
	}
	for _, field := range []string{"", "repositories"} {
		t.Run("conflict/"+field, func(t *testing.T) {
			s := &Server{HTTP: &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 409, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"message":"empty repository"}`))}, nil
			})}}
			visited := 0
			err := s.githubPages(context.Background(), "/repos/team/project/branches", "synthetic", field, func(M) bool { visited++; return false })
			if visited != 0 || (field == "" && err != nil) || (field != "" && err == nil) {
				t.Fatal(field, visited, err)
			}
		})
	}
}
