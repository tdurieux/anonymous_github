package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

func TestGitHubPagination(t *testing.T) {
	for _, field := range []string{"", "repositories", "installations"} {
		t.Run("past-old-boundary/"+field, func(t *testing.T) {
			calls, visited := 0, 0
			s := &Server{HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.Query().Get("page") != strconv.Itoa(calls) || r.URL.Query().Get("per_page") != "100" || r.URL.Query().Get("sort") != "pushed" || r.Header.Get("Authorization") != "Bearer synthetic" {
					t.Fatal("pagination changed request", r.URL)
				}
				body := "[" + strings.Repeat(`{"id":1},`, 99) + `{"id":1}]`
				if calls == 1001 {
					body = `[{"id":2}]`
				}
				if field != "" {
					body = fmt.Sprintf(`{"%s":%s}`, field, body)
				}
				headers := http.Header{}
				if calls < 1001 {
					headers.Set("Link", fmt.Sprintf(`<https://api.github.com/user/repos?sort=pushed&per_page=100&page=%d>; rel="next"`, calls+1))
				}
				return &http.Response{StatusCode: 200, Header: headers, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}}
			err := s.githubPages(context.Background(), "/user/repos?sort=pushed", "synthetic", field, func(row M) bool {
				visited++
				if visited == 100001 && number(row["id"]) != 2 {
					t.Fatal("last page lost")
				}
				return false
			})
			if err != nil || calls != 1001 || visited != 100001 {
				t.Fatal(calls, visited, err)
			}
		})
	}
	for _, mode := range []string{"empty", "exact-page", "early-match", "cancel", "upstream-error"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls, visited := 0, 0
			s := &Server{HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				status := 200
				body := "[" + strings.Repeat(`{"id":1},`, 99) + `{"id":1}]`
				if mode == "empty" || (mode == "exact-page" && calls == 2) {
					body = "[]"
				}
				if mode == "upstream-error" && calls == 2 {
					status = 503
				}
				headers := http.Header{}
				if mode != "empty" && !(mode == "exact-page" && calls == 2) {
					headers.Set("Link", fmt.Sprintf(`<https://api.github.com/user/repos?per_page=100&page=%d>; rel="next"`, calls+1))
				}
				return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}}
			err := s.githubPages(ctx, "/user/repos", "synthetic", "", func(M) bool {
				visited++
				if mode == "cancel" {
					cancel()
				}
				return mode == "early-match" && visited == 101
			})
			switch mode {
			case "empty":
				if err != nil || calls != 1 || visited != 0 {
					t.Fatal(calls, visited, err)
				}
			case "exact-page":
				if err != nil || calls != 2 || visited != 100 {
					t.Fatal(calls, visited, err)
				}
			case "early-match":
				if err != nil || calls != 2 || visited != 101 {
					t.Fatal(calls, visited, err)
				}
			case "cancel":
				if !errors.Is(err, context.Canceled) || calls != 1 || visited != 1 {
					t.Fatal(calls, visited, err)
				}
			case "upstream-error":
				if err == nil || err.Error() != "github_unavailable" || calls != 2 || visited != 100 {
					t.Fatal(calls, visited, err)
				}
			}
		})
	}
}
