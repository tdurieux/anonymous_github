package server

import (
	"net/http/httptest"
	"testing"
)

func TestProxyBoundary(t *testing.T) {
	for _, tc := range []struct{ trust, remote, forwarded, cf, want string }{
		{"", "192.0.2.1:12", "10.0.0.1", "203.0.113.2", "192.0.2.1"},
		{"loopback", "127.0.0.1:12", "203.0.113.2, 192.0.2.1", "", "192.0.2.1"},
		{"loopback,10.0.0.0/8", "127.0.0.1:12", "203.0.113.2, 10.0.0.1", "", "203.0.113.2"},
		{"1", "127.0.0.1:12", "203.0.113.2, 192.0.2.1", "", "192.0.2.1"},
		{"cloudflare", "173.245.48.1:12", "", "203.0.113.2", "203.0.113.2"},
		{"loopback", "[::1]:12", "2001:db8::1", "", "2001:db8::1"},
	} {
		var c Config
		if e := configureProxy(&c, tc.trust); e != nil {
			t.Fatal(e)
		}
		s := &Server{Config: c}
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = tc.remote
		req.Header.Set("X-Forwarded-For", tc.forwarded)
		req.Header.Set("CF-Connecting-IP", tc.cf)
		if got := s.clientIP(req).String(); got != tc.want {
			t.Errorf("trust %s: got %s want %s", tc.trust, got, tc.want)
		}
	}
}
