package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestTypeScriptAppTokenResponse(t *testing.T) {
	raw, err := os.ReadFile("testdata/oauth-tokens.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string
		Tokens   M
		Status   int
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
				data, _ := json.Marshal(c.Tokens)
				return &http.Response{StatusCode: c.Status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
			})}}
			tokens, err := s.exchange(context.Background(), M{})
			if err == nil {
				_, _, err = appTokenLifetimes(tokens)
			}
			if c.Expected == nil {
				if err != nil {
					t.Fatal(err)
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
func TestTokenLifetimeBounds(t *testing.T) {
	for _, v := range []any{math.Inf(1), math.NaN(), 1e20, "3600", true} {
		if _, ok := tokenLifetime(v); ok {
			t.Fatalf("accepted %T", v)
		}
	}
	if duration, ok := tokenLifetime(0.25); !ok || duration != 250*time.Millisecond {
		t.Fatal(duration, ok)
	}
}

func TestOAuthResponseFraming(t *testing.T) {
	for _, c := range []struct {
		body  string
		valid bool
	}{
		{`{"access_token":"synthetic"}`, true},
		{`{"access_token":"synthetic"} trailing`, false},
		{`{"access_token":"synthetic"}{}`, false},
		{`{"access_token":123}`, false},
		{`{"access_token":"synthetic"}` + strings.Repeat(" ", 65536), false},
	} {
		s := &Server{HTTP: &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(c.body))}, nil
		})}}
		_, err := s.exchange(context.Background(), M{})
		if (err == nil) != c.valid {
			t.Fatalf("valid=%v error=%v", c.valid, err)
		}
	}
}
