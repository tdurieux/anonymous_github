package server

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"
)

func runEmbeddedRefreshIntegration(t *testing.T, s *Server, p *fixtureProvider, call func(string, string, string, any) *httptest.ResponseRecorder, token string) {
	ctx := context.Background()
	for _, kind := range []string{"gist", "pr"} {
		t.Run(kind+" public refresh", func(t *testing.T) {
			filter := M{idKey(kind): "fixture-document"}
			load := func() M {
				t.Helper()
				r, e := s.Store.one(ctx, collection(kind), filter)
				if e != nil {
					t.Fatal(e)
				}
				return r
			}
			set := func(v M) {
				t.Helper()
				if _, e := s.Store.update(ctx, collection(kind), filter, M{"$set": v}); e != nil {
					t.Fatal(e)
				}
			}
			calls := 0
			p.onDocument = func() { calls++ }
			defer func() { p.onDocument = nil }()
			stale := time.Now().Add(-48 * time.Hour)
			set(M{"anonymizeDate": stale, "options.update": true})
			url := "/api/" + kind + "/fixture-document/options"
			w := call("GET", url, token, nil)
			if w.Code != 200 || calls != 0 {
				t.Fatal("owner bypass", w.Code, calls, w.Body)
			}
			w = call("GET", url, "", nil)
			if w.Code != 200 || calls != 1 || !date(load()["anonymizeDate"]).After(stale) {
				t.Fatal("automatic update", w.Code, calls, w.Body)
			}
			w = call("GET", url, "", nil)
			if w.Code != 200 || calls != 1 {
				t.Fatal("fresh content redownloaded", w.Code, calls)
			}
			set(M{"anonymizeDate": stale, "options.update": false})
			w = call("GET", url, "", nil)
			if w.Code != 200 || calls != 1 {
				t.Fatal("update opt-out ignored", w.Code, calls)
			}
			set(M{"status": "error", "statusDate": time.Now().Add(-10 * time.Minute), "statusMessage": "old_failure"})
			expected := 425
			if kind == "pr" {
				expected = 404
			}
			w = call("GET", url, "", nil)
			if w.Code != expected || calls != 2 || str(load()["status"]) != "ready" {
				t.Fatal("forced recovery", w.Code, calls, w.Body)
			}
			w = call("GET", url, "", nil)
			if w.Code != 200 {
				t.Fatal("recovery did not publish", w.Code, w.Body)
			}
			set(M{"status": "preparing", "statusDate": time.Now()})
			w = call("GET", url, "", nil)
			if w.Code != expected || calls != 2 {
				t.Fatal("premature recovery", w.Code, calls, w.Body)
			}
			set(M{"status": "expired", "statusDate": stale})
			w = call("GET", url, "", nil)
			if w.Code != 410 || calls != 2 {
				t.Fatal("expired document refreshed", w.Code, calls)
			}
			set(M{"status": "ready", "options.update": true, "anonymizeDate": stale})
			p.revoked = true
			w = call("GET", url, "", nil)
			p.revoked = false
			if w.Code != 403 || str(load()["status"]) != "error" {
				t.Fatal("refresh authorization failure", w.Code, w.Body)
			}
			set(M{"status": "ready", "anonymizeDate": stale})
			p.onDocument = func() { set(M{"status": "removing", "statusDate": time.Now()}) }
			w = call("GET", url, "", nil)
			if w.Code != 409 || str(load()["status"]) != "removing" {
				t.Fatal("refresh resurrected removed document", w.Code, w.Body)
			}
		})
	}
}
