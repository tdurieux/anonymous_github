package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func runDocumentLifecycleIntegration(t *testing.T, s *Server, p *fixtureProvider, call func(string, string, string, any) *httptest.ResponseRecorder, token string) {
	ctx := context.Background()
	for _, kind := range []string{"gist", "pr"} {
		t.Run(kind+" synchronous lifecycle", func(t *testing.T) {
			id := "document-lifecycle"
			base := "/api/" + kind + "/" + id
			body := M{idKey(kind): id, "source": M{"provider": "fixture", "gistId": "original-snippet", "repositoryFullName": p.name, "pullRequestId": 42}, "terms": []string{"Alice"}, "options": M{"expirationMode": "never", "title": true, "body": true, "content": true}}
			checkDocument := func(w *httptest.ResponseRecorder) {
				t.Helper()
				var result M
				if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil {
					t.Fatal(e)
				}
				field := "gist"
				if kind == "pr" {
					field = "pullRequest"
				}
				if w.Code != 200 || str(result["status"]) != "ready" || str(result[idKey(kind)]) != id || result[field] == nil {
					t.Fatal("incomplete save response", w.Code, w.Body)
				}
			}
			checkDocument(call("POST", "/api/"+kind, token, body))
			original := obj(body["source"])
			body["source"] = M{"provider": "fixture", "gistId": "changed", "repositoryFullName": "changed/project", "pullRequestId": 99}
			checkDocument(call("POST", base, token, body))
			record, e := s.Store.one(ctx, collection(kind), M{idKey(kind): id})
			if e != nil {
				t.Fatal(e)
			}
			if str(obj(record["source"])["gistId"]) != str(original["gistId"]) || str(obj(record["source"])["repositoryFullName"]) != str(original["repositoryFullName"]) {
				t.Fatal("settings update rebound source", record)
			}
			p.revoked = true
			defer func() { p.revoked = false }()
			w := call("POST", base+"/refresh", token, nil)
			if w.Code != 403 {
				t.Fatal("upstream refresh failure hidden", w.Code, w.Body)
			}
			p.revoked = false
			w = call("POST", base+"/refresh", token, nil)
			var result M
			json.Unmarshal(w.Body.Bytes(), &result)
			if w.Code != 200 || str(result["status"]) != "ready" {
				t.Fatal("refresh replied before completion", w.Code, w.Body)
			}
			job, e := s.Store.one(ctx, "gojobs", M{"_id": kind + ":" + id + ":prepare"})
			if e != nil || job != nil {
				t.Fatal("synchronous document queued preparation", job, e)
			}
			w = call("DELETE", base, token, nil)
			json.Unmarshal(w.Body.Bytes(), &result)
			if w.Code != 200 || str(result["status"]) != "removed" {
				t.Fatal("delete replied before removal", w.Code, w.Body)
			}
			w = call("GET", base+"/content", "", nil)
			if w.Code != 410 {
				t.Fatal("removed content exposed", w.Code, w.Body)
			}
			w = call("DELETE", base, token, nil)
			if w.Code != 410 {
				t.Fatal("repeat delete differs", w.Code, w.Body)
			}
			w = call("POST", base+"/refresh", token, nil)
			json.Unmarshal(w.Body.Bytes(), &result)
			if w.Code != 200 || str(result["status"]) != "ready" {
				t.Fatal("owner could not restore document through explicit refresh", w.Code, w.Body)
			}

		})
	}
}
