package server

import (
	"net/http/httptest"
	"testing"
)

func runConditionalResponseIntegration(t *testing.T, s *Server, p *fixtureProvider, ownerToken, otherToken string) {
	t.Run("conditional responses preserve access checks", func(t *testing.T) {
		call := func(path, token, tag, control string) *httptest.ResponseRecorder {
			request := httptest.NewRequest("GET", path, nil)
			request.RemoteAddr = "192.0.2.120:1234"
			if token != "" {
				request.Header.Set("Authorization", "Bearer "+token)
			}
			if tag != "" {
				request.Header.Set("If-None-Match", tag)
			}
			if control != "" {
				request.Header.Set("Cache-Control", control)
			}
			recorder := httptest.NewRecorder()
			s.ServeHTTP(recorder, request)
			return recorder
		}
		path := "/api/repo/second-provider"
		first := call(path, ownerToken, "", "")
		tag := first.Header().Get("ETag")
		if first.Code != 200 || tag == "" {
			t.Fatal("private response", first.Code, first.Body.String())
		}
		hit := call(path, ownerToken, "W/"+tag, "")
		if hit.Code != 304 || hit.Body.Len() != 0 || hit.Header().Get("Content-Type") != "" || hit.Header().Get("Content-Length") != "" {
			t.Fatal("private revalidation", hit.Code, hit.Header(), hit.Body.String())
		}
		for _, token := range []string{"", otherToken} {
			denied := call(path, token, "*", "")
			if denied.Code < 400 {
				t.Fatal("conditional private response bypassed access", denied.Code)
			}
		}
		reload := call(path, ownerToken, tag, "no-cache")
		if reload.Code != 200 || reload.Body.String() != first.Body.String() {
			t.Fatal("reload returned stale response", reload.Code, reload.Body.String())
		}
		path = "/api/repo/second-provider/file/XXXX-1.txt"
		first = call(path, "", "", "")
		tag = first.Header().Get("ETag")
		if first.Code != 200 || tag == "" {
			t.Fatal("file response", first.Code, first.Body.String())
		}
		opened := p.openCount.Load()
		for _, match := range []string{"W/" + tag, `"other", ` + tag, "*"} {
			hit = call(path, "", match, "")
			if hit.Code != 304 || hit.Body.Len() != 0 || p.openCount.Load() != opened {
				t.Fatal("file revalidation", hit.Code, hit.Body.String())
			}
		}
		p.revoked = true
		denied := call(path, "", "*", "")
		p.revoked = false
		if denied.Code < 400 {
			t.Fatal("conditional file bypassed revoked provider", denied.Code)
		}
		reload = call(path, "", tag, "no-cache")
		if reload.Code != 200 || reload.Body.String() != first.Body.String() {
			t.Fatal("file reload", reload.Code, reload.Body.String())
		}
	})
}
