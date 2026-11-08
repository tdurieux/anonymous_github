package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
)

func runValidationIntegration(t *testing.T, s *Server, p *fixtureProvider, call func(string, string, string, any) *httptest.ResponseRecorder, token, otherToken string) {
	// Give this contract batch its own client address so unrelated lifecycle
	// fixtures do not share the 120-attempt authentication budget.
	clientAddress := "198.51.100.2:1234"
	call = func(method, path, credential string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		req.RemoteAddr = clientAddress
		req.Header.Set("Content-Type", "application/json")
		if credential != "" {
			req.Header.Set("Authorization", "Bearer "+credential)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		return w
	}
	t.Run("TypeScript validation errors through HTTP", func(t *testing.T) {
		raw, e := os.ReadFile("testdata/validation.json")
		if e != nil {
			t.Fatal(e)
		}
		var cases []struct {
			Name, Kind string
			Body       M
			Expected   *struct {
				Code   string
				Status int
			}
		}
		if e = json.Unmarshal(raw, &cases); e != nil {
			t.Fatal(e)
		}
		for _, c := range cases {
			if c.Expected == nil {
				continue
			}
			w := call("POST", "/api/"+c.Kind, token, c.Body)
			var result M
			json.Unmarshal(w.Body.Bytes(), &result)
			if w.Code != c.Expected.Status || str(result["error"]) != c.Expected.Code {
				t.Fatalf("%s: %d %s", c.Name, w.Code, w.Body)
			}
		}
	})
	t.Run("TypeScript option persistence through HTTP", func(t *testing.T) {
		clientAddress = "198.51.100.3:1234"
		defer func() { clientAddress = "198.51.100.2:1234" }()
		raw, err := os.ReadFile("testdata/options.json")
		if err != nil {
			t.Fatal(err)
		}
		var cases []struct {
			Rejected       bool
			Name, Kind     string
			Body, Expected M
		}
		if err := json.Unmarshal(raw, &cases); err != nil {
			t.Fatal(err)
		}
		for i, c := range cases {
			clientAddress = fmt.Sprintf("198.51.102.%d:1234", i/30+1)
			id := fmt.Sprintf("option-contract-%d", i)
			c.Body[idKey(c.Kind)] = id
			c.Body["fullName"] = p.name
			c.Body["source"] = M{"provider": "fixture", "branch": "main", "commit": p.commit, "gistId": "snippet", "repositoryFullName": p.name, "pullRequestId": 1}
			w := call("POST", "/api/"+c.Kind, token, c.Body)
			if c.Rejected {
				var response M
				if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
					t.Fatal(err)
				}
				if w.Code != 400 || response["error"] != "invalid_options" {
					t.Fatalf("%s: %d %s", c.Name, w.Code, w.Body)
				}
				continue
			}
			if w.Code != 200 {
				t.Fatalf("%s: %d %s", c.Name, w.Code, w.Body)
			}
			if c.Kind == "repo" {
				w = call("GET", "/api/repo/"+id, token, nil)
				if w.Code != 200 {
					t.Fatalf("%s: %d %s", c.Name, w.Code, w.Body)
				}
			}
			var response M
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(obj(response["options"]), c.Expected) {
				t.Fatalf("%s HTTP options: got %s; expected %#v", c.Name, w.Body, c.Expected)
			}
			r, err := s.Store.one(context.Background(), collection(c.Kind), M{idKey(c.Kind): id})
			if err != nil {
				t.Fatal(err)
			}
			stored := obj(r["options"])
			if value, exists := stored["expirationDate"]; exists {
				stored["expirationDate"] = responseDate(date(value))
			}
			data, err := json.Marshal(stored)
			if err != nil {
				t.Fatal(err)
			}
			var actual M
			if err := json.Unmarshal(data, &actual); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, c.Expected) {
				t.Fatalf("%s: got %s; expected %#v", c.Name, data, c.Expected)
			}
		}
	})
	t.Run("authorize edits before validating request", func(t *testing.T) {
		w := call("POST", "/api/repo/second-provider", otherToken, M{})
		if w.Code != 403 {
			t.Fatal(w.Code, w.Body)
		}
	})
	t.Run("implicit existing provider retains opaque revisions", func(t *testing.T) {
		p.revoked = true
		defer func() { p.revoked = false }()
		body := M{"repoId": "second-provider", "fullName": p.name, "source": M{"branch": "main", "commit": p.commit}, "terms": []string{"Alice"}, "options": M{"expirationMode": "never", "image": true, "pdf": true, "link": true}}
		w := call("POST", "/api/repo/second-provider", token, body)
		if w.Code != 200 {
			t.Fatal("settings save required GitHub revision or live credentials", w.Code, w.Body)
		}
	})
	t.Run("numeric strings retain their TypeScript number value", func(t *testing.T) {
		for i, c := range []struct {
			input string
			want  int64
		}{{"1.0", 1}, {"0x10", 16}, {" 42 ", 42}} {
			id := []string{"numeric-one", "numeric-hex", "numeric-space"}[i]
			w := call("POST", "/api/pr", token, M{"pullRequestId": id, "source": M{"provider": "fixture", "repositoryFullName": p.name, "pullRequestId": c.input}, "terms": []string{}, "options": M{}})
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body)
			}
			r, e := s.Store.one(context.Background(), collection("pr"), M{"pullRequestId": id})
			if e != nil || number(obj(r["source"])["pullRequestId"]) != c.want {
				t.Fatal(c, r, e)
			}
		}
	})
}
